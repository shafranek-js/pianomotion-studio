# Native calculation repair — 2026-10-16

Checkout `C:\Projects\pianomotion-studio`, baseline `7edd431` (clean before repair), local version `0.1.0-dev.8`. No commit, push or deployment. [Review and implementation details](../../DUAL_ENGINE_REVIEW.md). [Machine-readable verification](latest-verification.json).

## Accepted scope

The reported Native errors and stretched Chopsticks hands were reproduced and repaired. MIDI identity, edit/replan, engine replacement and streamed pose handling are exercised through real calculation Workers. No audio implementation or Python musical algorithms were changed in this cycle.

| Check | Result | Evidence |
|---|---|---|
| Unit | 488 passed, 43 files; final manifest assertion rerun 5/5 | Local full report `test-results/reports/unit-dev8.json`; summary in `latest-verification.json` |
| Python | 31 passed, 54.98 s, separate `.venv-test` | `node tools/test-python.mjs`; summary in `latest-verification.json` |
| Typecheck / lint | Both exit 0 | `npm run typecheck`, `npm run lint` |
| Production build | Exit 0; build `32d5629e155acf05a9c372e5`, 255 resources, 72,739,523 bytes | Generated `apps/client/dist/offline-manifest.json`; summary above |
| Native Chrome | 1 full lifecycle test passed, no skips | [Report](native-chrome.json), [actual Worker messages](native-engine-browser-evidence.json) |
| Native Edge | 1 full lifecycle test passed, no skips | [Report](native-edge.json), [actual Worker messages](edge-native-engine-browser-evidence.json) |
| Python Chrome | 15/15 passed: all 13 unchanged goldens, cancellation, corrupt input | [Report](python-parity-chrome.json) |
| Full Native numeric parity | **OPEN, exit 1**: 5/13 fixtures fully match | [Per-fixture summary](native-parity-summary.json); full local report `test-results/reports/native-parity.json` |

Browser suites ran sequentially on installed Chrome/Edge on Windows. Their durations include dev-server startup. The lifecycle test opens built-in Chopsticks, edits a finger, switches Native → Python → Native, checks original MIDI hash/source IDs/manual assignments, performs Undo/Redo, seeks beyond the initial window, imports a different real MIDI and replans it. The Worker constructor wrapper forwards all operations to actual module Workers; it does not supply mocked results. Runtime selection for export has a unit test; a new actual video encoding run was not performed here.

## Geometry

Chopsticks before/after were captured from real Native Workers: 162 notes and 71 initial poses in both cases. The largest finger segment changed from **26.1932 in to 2.2524 in**; collapsed segments changed from 1057 to zero, and endpoints at the origin from 1215 to zero. [Measurements](hand-geometry-before-after.json).

Both browser lifecycle runs check all 71 startup poses and 49 post-seek poses, with zero geometry issues. Separate default-profile checks cover the initial windows of all 10 loaded fixtures (727 poses): no collapsed finger bones or segments above four inches. Invalid/repaired fixtures are listed with zero poses, not treated as animation passes. [Fixture measurements](fixture-initial-geometry.json). These are bounded-window checks, not a claim about every frame of every MIDI/profile.

The startup and post-seek screenshots were visually inspected; the giant hand shown in the original report is absent:

- [Startup](native-chopsticks-startup.png)
- [After seek](native-chopsticks-after-seek.png)

## Remaining gates and recorded failures

Native source SHA-256: `c8a6673eb79fa701cd1f4666ad72772105cdbfc13a91c8ddbc26dae5aa0be52c`. The API still declares the target Python manifest hash as `engineVersion`; that declaration is not proof of implementation equivalence. The source hash above identifies the independently compared TypeScript sources.

All fixture note identities and fingering assignments match. Full parity still finds **34 release-time component differences and 7367 raw-pose component differences**. These are individual differing values, not 7367 distinct poses. Expected values and tolerances were not changed. Python remains the reference/default. Run `npm run test:native-parity` to reproduce the open gate; this command deliberately fails on any difference.

The first Chrome lifecycle attempt used an incorrect dialog role for Unsaved changes; its harness was corrected to `alertdialog` and the full scenario passed. A later Edge attempt stopped on `Failed to fetch` for built-in Chopsticks before any Native analysis request. The cause was not established; an isolated rerun passed after adding network-failure tracing. It is recorded as an intermittent resource-loading failure, not a repaired engine defect. The successful Edge trace also contains two canceled SF3 fetches (`ERR_ABORTED`) during project replacement and no page errors; audio acceptance is not inferred from this test.

Production build emitted its existing large-main-chunk and Rolldown callback timing warnings. Full production PWA/offline, media, hardware, subjective audio and 2k/10k/50k load acceptance were not rerun for this repair. Source diff whitespace check passed with `core.whitespace=cr-at-eol`, preserving the pre-existing NUL/CRLF encoding of `api.ts`.

## Continue safely

Keep the current dirty tree and user assets. Do not reset site data or rewrite goldens. Investigate remaining release timing first, then raw pose discrepancies with minimal cases. Native source changes must change the production build ID, and export must retain the runtime of its frozen snapshot. Development server is available at `http://127.0.0.1:5173/`, serving dev.8; this is not a published release.
