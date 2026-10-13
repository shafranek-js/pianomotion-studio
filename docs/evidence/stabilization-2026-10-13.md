# Stabilization review — 2026-10-13

Scope: identified integration defects in the existing M1–M5 implementation. The user authorized stabilization after a read-only audit. Root coordinated GPT-6 Luna Extra High implementations and returned concrete review defects for correction. This is local implementation acceptance, not public release or full physical player acceptance.

## Final verification

| Check | Actual result | Execution boundary |
|---|---|---|
| `npm.cmd run typecheck` | PASS, exit0 | Root, all configured TS projects |
| `npm.cmd run lint` | PASS, exit0 | Root, configured client/contracts/config scope |
| `npm.cmd run test:unit` | **226/226**,13 files,5.05s | Root final consolidated Vitest run after render/test correction |
| `npm.cmd run build` | PASS, exit0;878 modules | Root, includes pinned runtime/core preparation |
| `npm.cmd run test:browser` | **22/22**,2.2min;workers1,retries0 | Root, fresh Vite4173, real Chromium and Pyodide Worker; before final render-only correction |
| Final player/stabilization browser checks | **4/4**,1.5min | Root rerun after render correction; player-m2 and stabilization specs |
| Final skin regressions | **24/24**,1 file | Included in final226; real golden, crossed thumb, incomplete skeleton |
| Desktop/browser corpus | **13/13**,0 numeric/discrete differences | Included in full22, not a second suite |
| New stabilization browser cases | **3/3** | Included in full22; real edits/exports/reloads |
| CPython replan | **4/4** | Delegated focused script; includes corpus/no-op, A/B/A, intents, rejection |
| CPython legacy export | **4/4** | Delegated focused script; MIDI/PIG roundtrip retained |
| Production build smoke | **PASS** | Root compiled preview4174;22 notes, stable IDs, manual pin,0 page errors/0 external HTTP; screenshot inspected before and after playback |

Root shell used direct Node/npm/Vitest/Playwright/ESLint equivalents with `login:false` to avoid PowerShell-profile delays; no npm install or lockfile edit was needed. Desktop148-test baseline was not rerun because desktop source was unchanged.

Engine snapshot: `bfd43f9e0647e99e976517a52526ff59e0e600a009964e93cc3d5fba411378d7`. Packaged12 Python modules; runtime12 files/21.37MiB with pinned hashes. Final direct Vite build compiled878 modules: main `index-gC6X_aHC.js`833.95kB (gzip241.88kB), Worker `midi-analysis.worker-BDY5vLaF.js`155.39kB. The earlier full npm build also passed runtime preparation; the final render-only rebuild reused those verified assets. These are build observations, not latency or memory targets.

The full browser run measured one initial fixture end-to-end at4506ms and stress512 warm at2029ms. Other warm fixtures ranged58–1201ms. `window.performance.memory` reported an approximate main heap40.15MiB; it does not measure Worker/WASM memory and is not a leak proof. No weak device was tested.

## Implemented changes

1. **Typed direct replan.** Original MIDI/resource and edited document/draft/profile/keyStyle enter `replan-document`. Persistent note IDs and original baseline are retained. Every response validates source identity, revision, profile, linked plans and manual pins. MIDI export/reimport no longer determines edited planning.
2. **Editor events and history.** View-only events no longer publish edits. Drafts update parent immediately; undo/redo revisions are monotonic. Same-source upstream results reconcile without resetting history/selection. Hidden editor does not consume global shortcuts.
3. **Central calculation lifecycle.** Parent debounces300ms, terminates superseded jobs, filters generation/identity, applies a coherent result to live scene and transport. Worker faults/timeouts are visible; retained draft can retry. Exports wait for current calculation instead of exporting an old plan.
4. **Audio restore.** Pure event-state reduction restores final key-down/pedal-held voices. Released history is not resynthesized. Equal-time ordering, sustain/sostenuto capture and soft-at-strike are covered. Replacing plans preserves clock, position and playing/paused state.
5. **Actual performed visuals/settings.** Highlighted keys and falling bars use PerformancePlan press/release. Source data stays recoverable; display metadata can include computed fingers. Settings reach transport/sampler/scene, including real Pixi FPS cap.
6. **Durable data.** Project/package saves preserve bytes, resource payloads, actual profile and linked plans; import helpers verify size/hash/context. Session restore covers completed and pending edits. Autosaves serialize overlapping writes. Profile/settings IDB migration preserves legacy data, returns committed revisions and surfaces write errors.
7. **Skin geometry.** Removed finger identity inference from X sorting; ordered DTO distal bones identify digits2,3,4,5,1 even during thumb crossings. Incomplete/ambiguous topology uses bounded fallback or omits invalid chains/labels. Fallback arithmetic stays in keyboard-local inches. Labels use the same mapping. The long diagonal finger strips found in production visual review are removed.
8. **Tooling/docs.** Original13 M6 lint errors and subsequent integration lint findings are resolved. README/handoff/roadmap/ADR context is aligned with actual scope and remaining gates;27 local documentation links exist.

## Meaningful regressions

`tests/browser/stabilization.spec.ts` exercises:

- Selection causes no Worker job. Finger4 → completed replan → Finger3 → completed replan → Undo returns finger4, keeps IDs and remains exportable. Replacing a plan while playing preserves playback; another replan while paused preserves the position. Downloaded MIDI is reimported through the actual Python Worker and retains the edited marker. No external HTTP requests observed in this path.
- Rapid profile changes resolve to the latest profile; equal geometry reaches returned/live plans. JSON package has matching source bytes/SHA and selected profile/plans. Reload restores exact document/fingering, profile, keyStyle and Split View after the committed autosave.
- An edit is autosaved while a real manifest response is delayed; reload retains its draft and recomputes, rather than accepting old derived plans as current. The test delays transport of actual assets, not the Python algorithm or result data.

Production audio/render regressions include a prefix of100 released notes plus one held note: restore creates only one sounding voice. Focused storage tests include a real IDB byte/profile/plan roundtrip, legacy migration, corruption classification, quota failure and serialized overlapping saves.

## Review corrections and intermediate failures

The first new browser runs were not accepted. Root returned the following defects, then repeated the relevant checks:

- Strict analysis-result validation received the extra keyStyle field from a replan result. The adapter now omits it before base-schema validation; a positive full result test prevents a rejection-only test from missing this path.
- Replan output dropped fingerMode/glissMode. Undo after a second completed calculation therefore rematerialized finger3 instead of4. Explicit intents now survive returned plans/history and have exact manual-pin guards.
- The initial audio restore replayed every historical event into live synth nodes at the current time. It was replaced with a pure reducer plus reconstruction of only final sounding voices.
- Source hash mismatch was initially classified as recompute-required; it is now corrupt, retained for explicit source recovery.
- A test used an async predicate inside waitForFunction and continued before autosave committed. Async IDB polling now uses expect.poll; the final reload regression waits for the exact revision/mode/state record. The passing full run occurred after source writers stopped.
- The production screenshot exposed stretched cartoon fingers despite green existing tests. Canonical digit order and coordinate units were fixed; review rejected a topology heuristic that could shift IDs in incomplete chains. The golden test now uses rawY/ppi, matching the Python adapter, and checks chain lengths and bounded extent. The first new test imported node:fs into app TS scope and failed the configured typecheck; static JSON import removed that issue. Final configured typecheck/lint and226 tests passed after correction.

Production images inspected by root: `C:\Users\pavel\.codex\visualizations\2026\10\13\01a134bd-3548-7483-bf3b-27bf94b721c4\handthesia-stabilized-fixed.png` and `handthesia-stabilized-playing.png`. Temporary preview4174 was stopped after verification; dev5175 remains the user-facing local server.

## Protected state and open acceptance

Desktop base remains `main`/`f8189c021d9235005fb35faa2c8cfbc09a3768a0`. Root Python/tests/version/CHANGELOG and active desktop environment were preserved; Python focused scripts only executed existing environments, without installing packages. `web/` and roadmap remain untracked; no stage/commit/push/deploy.

This closes the named stabilization defects in the tested local paths. It does **not** close:

- **W020 continuous motion/lookahead:** current `_selected_times` chooses first/middle/last and one intermediate attack time, so a one-hand example has only four diagnostic poses. Numeric sampled parity does not prove fingertip contact for every event. Complete bounded motion planning/seek invalidation and visual comparison before full player acceptance/M6 expansion.
- **Hand viewport composition:** current keyboard ends at canvas bottom, so the verified cartoon preview clips palm/wrist below the frame. Finger distortion is fixed; full hand framing and skin/keyboard contact comparison remain part of visual player acceptance.
- Weak-device and mobile behavior; actual Worker/WASM memory, long workloads2k/10k/50k, sustained rendering load, perceived audio/visual latency, and listening on physical outputs.
- UI opening of an arbitrary saved package/project list; package restoration helpers and current-session startup recovery are implemented.
- Automatic recovery of legacy sessions without a validated full analysis envelope. Data remains stored; explicit MIDI re-import is required.
- Complete SF2/Web MIDI/recording output integration, video/PWA/cloud and public release licensing. Root source license and bundled TimGM6mb.sf2 redistribution remain unresolved.

Earlier G2–G5 headings and helper-based M3 tests are historical implementation evidence, not proof of these unmeasured gates. The next safe work is motion-buffer/physical player acceptance, then a separately scoped M6 integration.
