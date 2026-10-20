#!/usr/bin/env python3
"""Check docs/firmware/manifest.json against the files it describes.

Every build must exist, match its size and SHA-256, and be firmware for the
chip its `family` says - judged from the vector table, as the installer does -
so a mislabelled file can never be offered for the wrong radio.
"""

import hashlib
import json
import struct
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"

# where each family's firmware is linked, and how big it may be
FAMILIES = {"v1": (0x00000000, 0xF000), "v3": (0x08002800, 118 * 1024)}
FW_XOR = bytes.fromhex(
    "4722c0525d574894b16060db6fe34c7cd84ad68b30ec25e04cd9007fbfe35405"
    "e93a976bb06e0cfbb11ae2c9c15647e9baf142b6675f0f96f7c93c841b26e14e"
    "3b6f66e6a06ab0bfc6a5703aba189e271a535b71b1941e18f2d6810222fd5a28"
    "91dbba5d64c6fe86839c501c730311d6af30f42c77b27dbb3f29285722d6928b")


def family_of(head: bytes) -> str | None:
    sp, reset = struct.unpack("<II", head[:8])
    if not (0x20000000 < sp <= 0x20004000) or not reset & 1:
        return None
    for fam, (base, size) in FAMILIES.items():
        if base <= reset < base + size:
            return fam
    return None


def main() -> int:
    manifest = json.loads((DOCS / "firmware" / "manifest.json").read_text())
    problems = []
    for b in manifest["builds"]:
        path = DOCS / b["file"]
        if not path.exists():
            problems.append(f"{b['id']}: {b['file']} is missing")
            continue
        data = path.read_bytes()
        if len(data) != b["size"]:
            problems.append(f"{b['id']}: size {len(data)}, manifest says {b['size']}")
        if hashlib.sha256(data).hexdigest() != b["sha256"]:
            problems.append(f"{b['id']}: SHA-256 does not match the manifest")
        fam = family_of(data) or family_of(bytes(x ^ FW_XOR[i] for i, x in enumerate(data[:8])))
        if fam != b["family"]:
            problems.append(f"{b['id']}: labelled {b['family']} but the image is {fam or 'unrecognised'} code")
        else:
            print(f"ok  {b['id']:<24} {b['family']}  {len(data)} bytes")
    for p in problems:
        print("FAIL", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
