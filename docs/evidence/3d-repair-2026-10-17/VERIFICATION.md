# R3D-01–04 — dev.12, 17 October 2026

Version correction: the user has already published dev.11. The current local release is 0.1.0-dev.12. Functional checks and screenshots below were collected with the dev.11 label before this metadata-only bump; their original version text and build ID are retained. The metadata-only dev.12 build passed: buildId 7e849361ce05ef3c92550cd1, 258 offline resources. Workspace/dependency/lockfile/release-text consistency checks and git diff --check passed. Musical test suites were not repeated for this version-only change.

## Scope and source state

Checkout: `C:\Projects\pianomotion-studio`. Work began at clean `d5caa72`, version `0.1.0-dev.10`. Three GPT-6 Luna Extra High agents owned scene/export semantics, hand geometry, and responsive Studio UI; the root agent reviewed the changes, returned integration defects, and performed independent acceptance.

During implementation a separate actor committed the feature changes as `74d0050`; the root agent did not stage/commit/push/deploy during that phase. The user subsequently authorized committing the remaining version/docs/media acceptance changes and deploying dev.12 through GitHub Pages. Deployment success must be verified separately against Actions and the live build ID. Existing user audio/SoundFont changes were preserved.

## Defect evidence

| ID | Fix | Verification |
| --- | --- | --- |
| R3D-01 | Fixed viewport cameras explicitly look at their target and update world matrices. No observer or pointer input is attached to an export renderer; a borrowed canvas remains owned by its caller. Partial construction is cleaned up through a typed helper. | Actual camera method/transform tests for all four presets, renderer-failure cleanup test, four real WebGL still frames and finalized MP4/WebM in Chrome. |
| R3D-02 | Presence of PerformancePlan determines the timing source, including an empty plan. No fallback to original excluded notes. Explicit active pitches and physical input remain separate. Pedal event arrays are prepared once per plan and reset when the plan changes. | Empty-plan/physical-input regression, rolled timing, early release, backward seek and hover tests. The original external empty-plan reproduction now passes. |
| R3D-03 | Removed the discontinuous `hoverLift > 0` fingertip floor. Reconstructed lift and pad correction apply continuously. | All five fingers on both hands, bent poses, near-zero coefficient, full lift sequence, distal scales, wrist/cuff/sleeve continuity, backward and repeated updates. Original 0→0.000001 reproduction now passes. |
| R3D-04 | Header camera controls have explicit grid rows and widths. Narrow screens use a native labelled camera select and 44px targets. Medium screens reflow instead of clipping Export/Preferences. | Actual DOM rectangles and visible controls at six required viewports plus eight boundaries; camera selection, playback, Fingering↔3D and session restoration in IAB Chromium. |

The first UI handoff still clipped controls at intermediate widths. It was returned to the UI owner and repaired before the final measurements. Constructor cleanup initially failed strict TypeScript; an `any` workaround was rejected and replaced with typed cleanup. These intermediate failures are not counted as acceptance passes.

## Automated checks

| Command/check | Result |
| --- | --- |
| `npm run typecheck` | PASS after final scene handoff |
| `npm run lint` | PASS after final scene handoff |
| `node node_modules/typescript/bin/tsc -p tests/browser/r3d/tsconfig.json` | PASS, including the final four-camera harness |
| Final Vitest, one worker | **556/556 tests, 53 files PASS** |
| `npm run test:native-parity` | **13/13 PARITY PASS**, expected values unchanged |
| Original external defect probes | **3/3 PASS**, previously 3/3 FAIL |
| `npm run build` | PASS; buildId `3ff65a7cd1d9165353a756bf` |
| Offline manifest generation | 258 resources, 73,925,154 bytes (70.50 MiB) |
| `git diff --check` | PASS after removal of trailing test-file blank lines |

The first full unit run with two workers timed out in `audio.test.ts` → `freezes musical time until file-backed output preparation has finished` (5s). No audio code or timeout was changed: the focused audio suite then passed 39/39 and the full sequential suite passed 556/556. Treat recurring occurrences as a separate test-stability investigation, not evidence of a repaired audio defect.

Engine: `60341216864eb0a548fbc66ba2b1848b9bb7b6b2de85c2c1e7f03fbd655bc63a`. Pyodide `314.0.7`. The main production JS chunk is still large (2,466.61 kB, gzip 775.32 kB); code splitting remains separate work.

## Real browser/media acceptance

Chrome reported `Chrome/155.0.0.0` on Windows. The checked-in dev harness creates a synthetic two-hand MIDI, analyzes it in a real Native Worker, freezes export inputs, creates an independent export Worker, renders with Three.js, encodes with WebCodecs/Mediabunny, demuxes and decodes both tracks, checks movement/skin pixels/audio RMS and performs native video playback and seek. It uses bounded Blob output without replacing WebCodecs, Worker, or the renderer with mocks.

All four fixed presets produced 1280×720 frames containing keyboard and hands: Concert, Overhead, Pianist POV and Side Arch. The root agent visually inspected the [full-page capture](chrome-all-cameras.png).

| Output | Frames | Video duration | Audio duration | Peak decoded RMS | Native seek |
| --- | --- | --- | --- | --- | --- |
| MP4, 1280×720 | 68 | 2.266667s | 2.275556s | 0.301055 | PASS |
| WebM, 1280×720 | 68 | 2.266s | 2.260s | 0.302870 | PASS |

Final encoded sizes: MP4 382,833 bytes, WebM 485,279 bytes. All video packets contain bytes and timestamps advance at 30 fps. Changed warm-skin pixels confirm moving hands separately from generic frame differences. Full metrics: [chrome-media.json](chrome-media.json). The browser automation could not export Blob links as local downloads; binary files are not included in this evidence folder. Demux/decode/playback checks operated on the actual finalized Blobs in Chrome.

IAB Chromium layout acceptance used actual DOM viewport sizes: 1920×1080, 1440×900, 1366×768, 1024×768, 768×1024, 390×844; boundaries 560/561, 899/900, 1199/1200 and 1899/1900. Final measured header controls had no intersections or offscreen rectangles; document scrollWidth equalled viewport width. [Measurements](layout.json), [mobile screenshot](mobile-390.png), [desktop screenshot](desktop-1440.png). The browser's zoom scaling was compensated when setting the viewport; the JSON records measured sizes.

Also checked: compact selector changes the camera, Play/Pause works, Fingering hides camera controls, Fingering↔3D retains position 7s and Overhead, and a reload restores the source project in 3D/Overhead after its original MIDI is validated. Transport position resets to lead-in on reload, as before.

## Reproduction and recovery

- Start Vite with `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`.
- Open `http://127.0.0.1:5173/@fs/C:/Projects/pianomotion-studio/tests/browser/r3d/acceptance.html` and press **Run MP4 + WebM checks**. This source harness is for development, not the production preview server.
- Existing production `media-export.spec.ts` now explicitly selects 3D. Helpers select the visible canvas and use a skin-aware 3D movement probe. The production media lane was updated but not executed in this turn.
- For a rendering problem, switch to Performance/2D; do not delete site data or IndexedDB. Retain original MIDI/project packages and the failing export's diagnostic message.
- Stop dev/preview servers before changing builds. To roll back, review the current branch/dirty tree first and preserve later edits; do not reset the user's checkout or silently replace a musical project. No storage migration was added by these four fixes.

## Acceptance limits

R3D-01–04 are implemented and the above local checks pass. Edge was not connected to the available browser controller, so its independent acceptance remains open. Full production PWA/browser/media CI, long clips, 4K/60fps, 50k-note load and physical MIDI were not rerun here. They are not implied by the short Chrome clips or the successful build. New photorealistic hand models and bundle splitting were not included.
