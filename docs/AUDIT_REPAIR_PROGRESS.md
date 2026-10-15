# Audit repair implementation — 2026-10-15

This is the active implementation record. The earlier A01–A16 "all closed" statement is superseded by the independent 2026-10-15 review. Existing dirty work and all frozen numerical fixtures are protected. No commits, push or deployment are authorized.

Current application version: **0.1.0-dev.2**, synchronized across root/client/contracts and lockfile. The status-bar version reads the client package rather than a separate hard-coded number. No release tag exists.

| Finding / original audit | Owner (GPT-6 Luna Extra High unless noted) | Implementation | Evidence / remaining acceptance |
|---|---|---|---|
| R01 / A02,A03: save/update barrier | Orchestrator | Automatically verified in Chrome and Edge | Unit checks and actual project-transaction abort / late-edit-before-controllerchange browser scenarios passed. Revision/token/handler identity is checked before activation and again before reload. |
| R02 / A03: coherent releases | repair_pwa | Automatically checked in Chrome and Edge | Actual A/B/C releases preserve pinned A/B tabs while C controls them; old A assets remain available offline beyond the usual two retained builds. Exact `/pianomotion/` MIDI import/save/offline restore and distinct nested/flat cache scopes passed. Release builder pins production mode even when its caller sets NODE_ENV=development. |
| R03 / A03: atomic cache promotion | repair_pwa | Automatically checked in Chrome and Edge | Corrupt and truncated resources, then failure on the second final-cache write, all reject the update. Incomplete caches are removed, clean retry succeeds, and foreign cache remains untouched. Completion marker is checked. |
| R04 / A04: export dimensions/snapshot | repair_pwa; root scene integration | Automatically checked in Chrome and Edge | Actual MP4 1920×1080 and WebM 1280×720 decoded, sought and measured with moving hands and audio. Six real media scenarios pass per channel. UI gate and temporary verification-build override were removed. |
| R05 / A05,A14,A15: recording map/DSP | repair_audio | Automatically checked in Chrome and Edge | Real local Signalsmith 1.3.2 AudioWorklet under the production CSP passed all seven speeds after the final async fixes. Final pitch error <3 cents, marker error ≤7.5 ms. Deferred stop-RPC intent and native offline cancellation/settlement have regression tests. No varispeed fallback. |
| R06 / A14: one master gain | repair_audio | Automatically checked | Unit WAV/volume/plan-event regressions pass; normalization precedes master volume, SF2 internal gain is 1. Real native DSP/SF2 and decoded media audio also pass. Listening remains separate. |
| R07 / A06: SF2 scheduled time | repair_audio | Automatically checked with synthetic bank; user-bank gate open | Timestamped attacks/releases/pedals and independent note IDs are unit-checked. Actual synthetic RIFF upload/Worker parse/activation, invalid-file rejection and reload recovery pass in both browsers. A real user's bank still needs manual acceptance. |
| R08 / A06,A15: MIDI queue | repair_audio | Unit-checked; physical-device gate open | Queue clear, timestamp mapping, state restoration, explicit sysex:false permission/channel and disconnect stop are implemented. Emulated port/unit checks do not replace hardware acceptance. |
| R09 / A09: request lifecycle | repair_motion | Automatically verified in Chrome and Edge | Result/error/cancel/timeout/stale unit scenarios pass. Actual Worker analyze → replan → stream → new Worker restore → stream passed on both channels. |
| R10 / A10: continuous coverage | repair_motion | Implemented and automatically checked | Metadata is intersected with actual per-hand pose intervals (max gap 250 ms) and required anchors. Contradictory coverage and bounded continuation regressions are included in 31 focused motion tests. Both real-Worker browser runs passed. |
| R11 / A11–A13: bounded startup/resources | repair_motion | Implemented; load acceptance limited | Separate sparse diagnostics and 4s/200 initial playback window, strict Python/TS caps, paired groups and one animator session are checked. 2k-note analysis completed; 10k and a valid 50k MIDI exceeded 120s and were terminated. Those loads are not accepted as supported. |
| R12 / A02,A06: asset commit | repair_pwa | Implemented, focused automated pass | 4 asset-store unit tests and actual IndexedDB put-success→abort/delete-abort browser cases passed. Selected asset ID is persisted after commit. |
| R13 / A06 SF2 details: pedal-aware mode 3 | repair_audio | Automatically checked | Actual OfflineAudioContext modes 0/1/3, held-loop versus released-tail measurements and 100 sequential notes passed in both channels. Voices use the audio clock; no wall-clock release timer. |
| R14 / A04,A16: export success/fallback | repair_pwa; root integration review | Automatically checked in Chrome and Edge | No MediaRecorder. Real codec absence, native close failure, cancellation and focus scenarios pass. Success requires finalize/close and native playback with audio for both formats. The 128 MiB Blob byte limit is unit-checked, not a physical 128 MiB export stress pass. |

The orchestrator owns App/Player integration, shared contracts, package manifests/lockfile, and final acceptance. Implementation handoffs do not close findings. Every finding requires its original scenario and independently checked evidence. Real bank/device listening, Chrome/Edge and stress acceptance remain explicit until measured.

## Latest automated verification — 2026-10-15

| Group | Chrome 154.0.8037.98 / Windows | Edge 155.0.4283.45 / Windows |
|---|---|---|
| Studio / storage / responsive UI | 17/17 passed | 17/17 passed |
| Actual Worker / parity | 16/16 passed; all 13 fixtures, zero differences | 16/16 passed; all 13 fixtures, zero differences |
| Actual DSP / synthetic SF2 UI | 2/2 passed after final async fixes | 2/2 passed after final async fixes |
| Production PWA | Seven cases passed in the full run; exact `/pianomotion/` case passed on focused rerun after fixing the test's temporary-directory prefix | 8/8 passed in one full run |
| Encoded / decoded media | 6/6 passed on the ordinary build | 6/6 passed on the ordinary build |

Core verification: **397/397 unit tests, 27 files; 28/28 Python tests with no skips; typecheck, full lint and production build passed**. Scoped lint also covers the new browser cases and the final production-mode/default-output guard fixes. The 13 goldens retain their original expected values. Runtime engine: `83fde5039dd70360c29aa5a3edbb07fc2f024528c76330b42bc55e195cb8fbc7`; final normal root build: `312c85de84dd46900f62db63`, 85 mandatory files, 30.40 MiB.

Raw browser reports are retained under `evidence/audit-repair-2026-10-15/browser/`; decoded frames, metrics and actual MP4/WebM files are under `media/`. Reports with `before-...-fix` in their name intentionally retain failed intermediate runs, not outstanding acceptance failures. Chrome PWA's original full run had a test-only custom-output prefix failure; the corrected exact base-path case was then verified independently. No active final scenario is hidden behind a skip.

Machine-readable outcome and build provenance: [latest-verification.json](evidence/audit-repair-2026-10-15/latest-verification.json). The ordinary media runs used build `3b3bb27fd95bb6516fbaa81b`; the PWA matrix used `0dbd4b3742fc7e9294466f60` with production-mode isolation. Final build `312c85de84dd46900f62db63` additionally validates the default dist directory before Vite can empty it. Export/audio/render code did not change between those builds. Final release file sizes and SHA-256 hashes were independently verified for all 85 entries. No commit, push, tag, publication or site-data deletion was performed; HEAD remains `dc7eb963ff793110c586b4e86129cb22282cd452` with the user and remediation work uncommitted.

The local groups were run separately and sequentially, not presented as an executed remote CI workflow. A configured workflow is not a remote CI pass. The final `312c85de84dd46900f62db63` build also passed a fresh real Chrome online-analysis → offline restore → different MIDI import → save scenario (1/1, 20.6 s). Browser samples and two decoded frames per format were independently inspected; full subjective listening/motion review remains a manual gate.

## Intermediate runs and integration findings

- Baseline before this repair: HEAD `dc7eb963ff793110c586b4e86129cb22282cd452`, dirty tree; 331 unit tests, 22 Python tests, 13 numerical fixtures. The independent browser audit had failures and unrun tests.
- 2026-10-15 08:17 Prague: full unit run **352/352, 24 files**, 10.10s. This preceded final audio/video changes and is an intermediate result.
- Full Python run **27/27**, 55.54s, separate `.venv-test`, no changes to desktop `.venv`. All frozen numerical goldens are exercised; fixture files remain unchanged.
- Integrated typecheck passed after version/output/source-identity changes. Initial lint errors were returned to their owners and root App/Player corrections applied; these intermediate results are superseded by the matrix above.
- Machine/build metadata is recorded in `evidence/audit-repair-2026-10-15/environment.json`. An engine/build hash recorded during active implementation is not necessarily the final hash.
- Chrome UI: 15/16 passed in the full run; the outdated disabled-output assertion was corrected and the affected test passed on a focused rerun. Edge UI: **16/16 passed** in one full run. Six viewport sizes, 88 keys, package roundtrip, editor history and save/update barriers were covered. Wide and mobile screenshots were independently viewed.
- Chrome Worker/parity: **16/16 passed, 1.9 min**. Edge Worker/parity: **16/16 passed, 2.8 min**. All 13 frozen numerical fixtures reported zero differences; actual replan/restore streaming and cancellation/corrupt-input scenarios passed.
- Full typecheck and full lint passed after the integrated audio/video/source-identity changes. Automatic results do not close the listed physical-device/listening or load gates.
- Stress details: `motion-benchmark.json` and `motion-benchmark-50k-valid.json`. The valid 50k case used PPQ 120 and max tick 2,999,970, below the parser guard; it timed out. Measurements cover Worker analysis with page heartbeat/RAF, not a loaded 50k-note Pixi/editor scene.
- Later full core run: **394 unit tests / 27 files**, then **28 Python tests / 63.75 s**, followed by typecheck/lint/build pass. Three further audio/video regressions were added afterwards; final unit total must be read from the final run.
- Independent integration review corrected request-scoped export plan IDs (new request IDs are valid if exact fingering intent/events still match), deferred recording intent, outstanding native SF2 render settlement, `getMimeType()` ordering, WebM frame-rate metadata, Escape after focus falls to body, and stale modal callbacks.
- WebM Opus SimpleBlocks omit explicit packet duration. Mediabunny reports zero for each cluster's final audio packet; acceptance checks nonempty bytes, continuous timestamps, container/track duration and native decoded audio rather than treating omitted duration as an empty packet. Video DefaultDuration is declared through fixed `frameRate` track metadata.
- The full production PWA suite exposed inherited NODE_ENV=development after a programmatic Vite server. Release builds now force production in the Vite child regardless of their caller; the A/B/C and subpath tests deliberately supply development to verify that isolation.

## Verification entry points

`npm run test:unit`, `test:python`, `typecheck`, `lint`, `build`; then **sequentially** `test:browser` (studio/UI/storage), `test:worker` (real Worker and 13-fixture parity), `test:audio` (real DSP/SF2), `test:offline` (production PWA), `test:media` (actual container decode). `npm run test:browser:all` runs those browser groups in order. `PIANOMOTION_BROWSER_CHANNEL=chrome` or `msedge` selects the installed browser. CI defines both Windows channels; an authored workflow is not a completed CI run.

Stress harness: `node tools/benchmark-motion.mjs --base-url http://127.0.0.1:4173`, with explicit per-case timeout and JSON evidence. A timeout/error remains a limitation; it is not a supported-load pass. Do not run heavy browser suites concurrently.

Manual gates still open: physical MIDI behavior/disconnect, a real user's bank after restart, subjective listening and export review. Source distribution rights remain unresolved; see `evidence/licenses-2026-10-15.md`. Recovery/rollback must preserve IndexedDB and unrelated caches; see `ROLLBACK.md`.
