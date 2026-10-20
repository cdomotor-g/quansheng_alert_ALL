# quansheng_alert_ALL — get a Quansheng radio receiving ALERT flood telemetry

### → **[cdomotor-g.github.io/quansheng_alert_ALL](https://cdomotor-g.github.io/quansheng_alert_ALL/)**

The one link to give someone who wants a Quansheng handheld that decodes ALERT
flood-warning telemetry (rain gauges and river-level stations) on its own
screen. The site has:

* **a setup guide**: what ALERT is, what hardware to buy (with photos), how
  to tell which radio you have, a walk-through of the install, every screen,
  key and setting, logging to a computer, troubleshooting, and downloads;
* **an installer that runs in the browser** (Chrome or Edge, Web Serial). It
  handles **both** families of radio. It backs the radio up, puts it in
  bootloader mode, writes the firmware, and confirms the result. It reads the
  radio's bootloader before writing anything, and refuses firmware built for
  the other chip;
* **the firmware itself**, refreshed weekly from source, plus the tools
  (cable diagnosis, a guide to building a cable, links to the logging client).

| Radio | Chip | Firmware comes from | Status |
|---|---|---|---|
| UV-K1, UV-K5 V3 (`UV-K5(99)`), bootloader 7.x | PY32F071 | [quansheng_alert_v3](https://github.com/cdomotor-g/quansheng_alert_v3) | decodes on air, no modification |
| UV-K5, UV-K5(8), UV-K6, UV-5R Plus, bootloader 2.x | DP32G030 | [quansheng_alert](https://github.com/cdomotor-g/quansheng_alert) (archived) | experimental: V3 decoder, needs a one-capacitor mod, not yet tried on air |

This repository holds no firmware source. It is the front door for the two
repositories above.

## Layout

```
docs/                     the site, served by GitHub Pages (main branch, /docs)
docs/index.html           the setup guide
docs/flash/               the installer
docs/cable/               build-your-own programming cable (from quansheng_alert)
docs/js/k5protocol.js     wire protocol for both families: framing, images, commands
docs/js/k5radio.js        Web Serial transport: backup, restore, flash (v1 and v3)
docs/js/installer.js      the installer wizard
docs/js/guide.js          the guide's tabs, credits and download table
docs/firmware/            v1/ and v3/ builds + manifest.json (written by CI)
docs/img/                 photos (credited in docs/img/photos/credits.json),
                          diagrams, and screenshots captured from a radio
docs/tools/k5diag.py      command-line cable / radio diagnosis
tools/build_manifest.py   gathers both families' firmware and writes the manifest
tools/check_manifest.py   checks every file matches the manifest and its family
test/                     protocol vectors, installer and site tests
```

## How the firmware stays current

`.github/workflows/refresh-firmware.yml` runs every Monday, on demand, and on a
`firmware-updated` repository dispatch. It:

1. copies the UV-K5 builds that `quansheng_alert` publishes in its `docs/firmware/`;
2. checks out `quansheng_alert_v3` and builds exactly what that repository's CI
   builds (`cmake --preset RescueOps -DENABLE_ALERT=ON`), with
   `SOURCE_DATE_EPOCH` set to the commit time so the same source always gives
   the same bytes;
3. writes `docs/firmware/manifest.json`, checks every image against it, and
   commits only if something changed.

To publish a new V3 build immediately, run the workflow from the Actions tab.

## How the installer handles two kinds of radio

Both families speak the same framed, obfuscated serial protocol, and both
bootloaders broadcast a beacon carrying their version. They differ in:

| | UV-K5 family (v1) | V3 / UV-K1 (v3) |
|---|---|---|
| bootloader | 2.x | 7.x |
| firmware linked at | `0x00000000`, ≤ 60 KB | `0x08002800`, ≤ 118 KB |
| handshake | `0x0530` + 16-byte firmware version | `0x0530` + `"7.00"`, once per beacon, three times |
| flash write | `0x0519`, block address | `0x0519`, page index + page count; reply carries an error code |
| connection | two-pin cable only; port survives power cycles | USB-C (port disappears when the radio is off, and re-appears with a new id in bootloader mode) or two-pin cable |
| backup | 8 KB EEPROM, calibration at `0x1E00` | the firmware's virtual EEPROM: channels `0x0000`, settings `0xA000`, calibration `0xB000` |

The family of a firmware image is read from its vector table (where the reset
vector points). The family of a radio is read from its bootloader beacon. If
the two disagree, nothing is written. The v3 half follows muzkr's
`serialtool` (MIT), and `test/test_k5protocol.mjs` checks the bytes against
vectors produced by running it. `test/test_installer.mjs` drives the whole
wizard against simulated radios of both kinds and compares what they receive
with the published images byte for byte.

## Testing

```sh
npm install                 # Playwright, for the browser tests
npm test                    # protocol vectors, installer, guide page
python3 tools/check_manifest.py
```

## Publishing the site (one-time, repository owner)

GitHub → **Settings** → **Pages** → *Build and deployment*: **Source: Deploy
from a branch**, **Branch: `main`**, **Folder: `/docs`** → **Save**. A minute
later it is live at `https://cdomotor-g.github.io/quansheng_alert_ALL/`, and
every push updates it.

The folder must be `/docs`. With `/ (root)` the site URL shows this README and
the installer's paths 404; the root `index.html` then forwards visitors to
`docs/` as a stopgap, but links straight to `/flash/` still break.

## Credits and licences

The installer grew out of the one in
[quansheng_alert](https://github.com/cdomotor-g/quansheng_alert). The protocol
was worked out by [k5prog](https://github.com/sq5bpf/k5prog),
[uvmod](https://github.com/whosmatt/uvmod) and
[uvtools](https://github.com/egzumer/uvtools); the V3 bootloader protocol
follows [muzkr](https://github.com/muzkr)'s serialtool. The firmware builds on
[DualTachyon](https://github.com/DualTachyon/uv-k5-firmware),
[egzumer](https://github.com/egzumer/uv-k5-firmware-custom) and
[F4HWN / armel](https://github.com/armel/uv-k1-k5v3-firmware-custom), under
Apache-2.0. Photos are credited individually in `docs/img/photos/credits.json`
and on the site.

The site and tools in this repository are MIT-licensed (`LICENSE`). The
firmware images in `docs/firmware/` are Apache-2.0, as distributed by the
repositories they come from.
