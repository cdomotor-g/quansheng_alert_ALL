#!/usr/bin/env python3
"""Gather both radios' firmware into docs/firmware/ and write its manifest.

This repository builds no firmware of its own. It republishes:

  v1  the builds that cdomotor-g/quansheng_alert already publishes in its own
      docs/firmware/ (UV-K5 / UV-K5(8) / UV-K6, DP32G030), copied as they are;
  v3  one build of cdomotor-g/quansheng_alert_v3 (UV-K5 V3 / UV-K1, PY32F071),
      the RescueOps preset with ENABLE_ALERT=ON - exactly what that
      repository's CI builds - compiled by the workflow that runs this.

    tools/build_manifest.py --v1-repo ../quansheng_alert \\
        --v3-repo ../quansheng_alert_v3 --v3-bin build/RescueOps/f4hwn.rescueops.bin

The installer (docs/flash/) reads the manifest; the guide (docs/index.html)
links the files. Standard library only.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FWDIR = ROOT / "docs" / "firmware"
MANIFEST = FWDIR / "manifest.json"

V3_FILE = "quansheng-alert-v3.bin"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True,
                          capture_output=True, text=True).stdout.strip()


def v1_builds(repo: Path) -> list[dict]:
    """Copy quansheng_alert's published builds and describe them."""
    src = repo / "docs" / "firmware"
    upstream = json.loads((src / "manifest.json").read_text())
    out_dir = FWDIR / "v1"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.bin"):
        old.unlink()

    builds = []
    for b in upstream["builds"]:
        packed = Path(b["file"]).name
        shutil.copy2(src / packed, out_dir / packed)
        entry = {
            "id": f"v1-{b['id']}",
            "family": "v1",
            "title": b["title"],
            "description": b["description"],
            "badge": "Experimental",
            "badge_kind": "exp",
            "file": f"firmware/v1/{packed}",
            "size": (out_dir / packed).stat().st_size,
            "sha256": sha256(out_dir / packed),
            "stations": b.get("stations"),
            "built": b.get("built"),
            "order": 100 + b.get("order", 0),
            "source": {"repo": "cdomotor-g/quansheng_alert", "commit": b.get("commit")},
        }
        raw = b.get("raw_file")
        if raw:
            shutil.copy2(src / Path(raw).name, out_dir / Path(raw).name)
            entry["raw_file"] = f"firmware/v1/{Path(raw).name}"
        builds.append(entry)
    return builds


def v3_build(repo: Path, binary: Path) -> dict:
    """Publish one V3 build, described from the source it was compiled from."""
    out_dir = FWDIR / "v3"
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / V3_FILE
    if binary.resolve() != dest.resolve():
        shutil.copy2(binary, dest)

    header = (repo / "App" / "app" / "alert_stations_gen.h").read_text()
    m = re.search(r"#define\s+ALERT_STATIONS_COUNT\s+(\d+)", header)
    stations = int(m.group(1)) if m else None
    networks = []
    filt = repo / "filters" / "stations.filter"
    if filt.exists():
        networks = [ln.split(None, 1)[1].strip() for ln in filt.read_text().splitlines()
                    if ln.startswith("network ")]

    commit = git(repo, "rev-parse", "--short", "HEAD")
    built = git(repo, "log", "-1", "--format=%cs")
    return {
        "id": "v3-alert",
        "family": "v3",
        "title": "ALERT receiver — UV-K5 V3 / UV-K1",
        "description": ("F4HWN RescueOps edition with the ALERT receiver app. Station names built in: "
                        + (", ".join(networks) if networks else "South-East Queensland")
                        + ". Other regions can be loaded over USB."),
        "badge": "Recommended",
        "badge_kind": "good",
        "file": f"firmware/v3/{V3_FILE}",
        "size": dest.stat().st_size,
        "sha256": sha256(dest),
        "stations": stations,
        "built": built,
        "order": 10,
        "source": {"repo": "cdomotor-g/quansheng_alert_v3", "commit": commit,
                   "preset": "RescueOps", "options": "-DENABLE_ALERT=ON"},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--v1-repo", type=Path, required=True, help="checkout of cdomotor-g/quansheng_alert")
    ap.add_argument("--v3-repo", type=Path, required=True, help="checkout of cdomotor-g/quansheng_alert_v3")
    ap.add_argument("--v3-bin", type=Path, required=True, help="the RescueOps ALERT build's .bin")
    args = ap.parse_args()

    builds = v3_build(args.v3_repo, args.v3_bin), *v1_builds(args.v1_repo)
    builds = sorted(builds, key=lambda b: b["order"])

    # Only the builds' identities go in the comparison, so re-running on the
    # same sources leaves the manifest byte-for-byte as it was.
    old = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    if old.get("builds") == builds:
        print("manifest unchanged")
        return 0

    MANIFEST.write_text(json.dumps({
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "builds": builds,
    }, indent=2) + "\n")
    for b in builds:
        print(f"{b['id']:<24} {b['size']:>7} bytes  {b['sha256'][:12]}  {b['source']['commit']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
