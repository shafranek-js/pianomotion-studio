# W007 reference machine and performance profile — 2026-10-13

## Observed reference environment

Collected from the current development machine and checkout. Hardware serials, machine name, user name, and personal directories are intentionally omitted.

| Field | Observed value |
|---|---|
| OS | Microsoft Windows 11 Pro, version 10.0.26200, build 26200, 64-bit |
| CPU | Intel Core i7-11700F, 8 cores / 16 logical processors |
| Installed RAM | 32 GiB |
| Node.js / npm | Node.js v24.14.0 / npm 11.9.0 |
| Python | Python 3.14.0 |
| Microsoft Edge | 155.0.4283.45 (installed executable metadata) |
| Google Chrome | 154.0.8037.98 (installed executable metadata) |
| Firefox | Not detected in the checked command path or standard install directory; availability remains unknown. |
| Git base commit | `f8189c021d9235005fb35faa2c8cfbc09a3768a0` (the tested checkout also contained uncommitted M0 workspace changes) |

The installed system Edge and Chrome builds above were not used for the web app check. Bootstrap separately ran one headless Chromium smoke test using Playwright 1.64's cached Chromium headless shell `156.0.8078.4`; it passed in 6.6 seconds and checked the page title, heading, status text, and browser page errors. This verifies only that smoke path. The test did not exercise MIDI, motion, performance, or the installed system browsers. Actual viewport/GPU state for the test, browser flags, thermal/power state, and background-tab behavior were not measured. No weak-device or mobile device was available for this evidence; their capabilities and limits are **Unknown**.

## Proposed fixture tiers

These sizes define a repeatable workload proposal for later W005/W014/W054 fixtures. They are not existing fixture counts or measured results.

| Tier | Proposed song workload |
|---|---|
| Small | 30 seconds, up to 2,000 notes, up to 2 tracks; basic tempo and pedal events. |
| Representative | 5 minutes, up to 10,000 notes, up to 4 tracks; overlaps, repeated same-pitch notes, tempo changes, controllers 64/66/67, glissando, crossings, and wide chords. |
| Stress | 10 minutes, up to 50,000 notes, up to 8 tracks; dense overlaps and repeated events to exercise parsing, planning, cache bounds, and cancellation. |

Fixtures should be generated from original material that the project can redistribute. They must not use the ignored PIG corpus or third-party MIDI collections unless their terms are independently established. No audio samples are part of this profile.

## Proposed acceptance targets, not approvals or results

- At a repeatable 1920×1080 browser viewport, target 60 rendered frames per second and p95 main-thread scene work at or below 16.7 ms. Measure JavaScript work and visible smoothness separately.
- Over the 10-minute stress fixture, target no accumulating audio-to-visible-event drift and an observed offset no greater than 50 ms; document the output device and measurement method.
- Target visible request feedback within 100 ms and cancellation/termination of a heavy Worker job within 1 second.
- Keep pose/cache memory bounded by playback lookahead instead of total animation duration. Set numeric memory limits only after measuring the reference and a real weak device.
- On the agreed parity corpus, target identical hand/finger assignments; initial numeric comparison tolerances are 1 ms for event time and 0.01 white-key widths for coordinates. Validate these tolerances before relying on them.

All numeric targets above are **Proposed**; none is approved, tested, or achieved by W007. The present evidence contains no browser benchmark, audio measurement, mobile test, viewport capture, or performance result. A weak-device profile remains **Unknown** until a real device is checked.
