# Instructions for Claude Code

This repository is the front door for getting a Quansheng radio receiving ALERT telemetry:
the setup guide and browser installer in `docs/`, and the firmware builds the weekly
`refresh-firmware.yml` gathers from quansheng_alert_v3 and quansheng_alert. It holds no
firmware source. `README.md` explains the layout.

## Atlas — this repo on the map of all the repos
- This repo is **`quansheng-all`** on the Atlas (<https://cdomotor-g.github.io/atlas/>). How to work with the map — `atlas.json`, the repositories that rely on this one, asks, pins, status and blockers — is in the shared instructions (`shared/on-the-atlas.md` in the Atlas).
- The firmware pins move by themselves: `refresh-firmware.yml` rewrites `docs/firmware/manifest.json` every Monday. The screenshots copied from quansheng_alert_v3 do not — when its `tools/alert/screens/` change, copy them and move `v3-screens`' date.

<!-- shared:start · written by tools/shared.mjs in cdomotor-g/atlas; the rules themselves live in its shared/ folder -->
## Shared instructions — loaded from the Atlas
The rules every one of my repositories shares live in one file in the Atlas: how to end a run (the run summary), pushing to `main`, plain words, private data, who clears what, and issue titles — <https://github.com/cdomotor-g/atlas/blob/main/shared/instructions.md>. This repository is on the Atlas map, so <https://github.com/cdomotor-g/atlas/blob/main/shared/on-the-atlas.md> holds as well.
`.claude/settings.json` loads them when a session starts. If they are not in front of you, fetch them before you reply (`curl -fsS https://raw.githubusercontent.com/cdomotor-g/atlas/main/shared/instructions.md`, and the same for `on-the-atlas.md`) and follow them. Where this file says something different, this file wins.
<!-- shared:end -->
