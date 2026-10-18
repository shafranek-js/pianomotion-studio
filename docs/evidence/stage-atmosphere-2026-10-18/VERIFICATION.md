# Scattered stage light — dev.19, 2026-10-18

Checkout: `C:\Projects\pianomotion-studio`. Local changes only; no stage/commit/push/deploy. Existing dirty stage/audit/menu/hand-rig changes are preserved. Source reference: the user-provided poster `C:\Users\pavel\AppData\Local\Temp\codex-clipboard-1648fafd-05a6-4106-b367-f734d67bdf92.png`.

## Implementation and review

`pianoStageAtmosphere.ts` adds depth-tested, transparent, open tapered shells behind the piano and a separate circular floor-glow shader. The shaft is centered at (0,17,-52), spans Y=-19..53 and uses a continuous `pow(facing,4)` profile with smooth height fades. Mild taper and low cyan-blue opacity create a soft column instead of a visible cone. The perimeter has a broad radial band multiplied by the floor's 70–100% radius fade; no geometry extends past the radius-80 platform.

Concert enables the effect. Studio hides it. Existing brightness scales opacity; quality selects two shells for Low/Auto ≤900 px, three for High/Auto >900 px. All four meshes are preallocated (three shaft shells and one glow); cylinder subdivision is 64 radial ×1 height, with no postprocess target, animation timer or random frame noise. Geometry does not cast shadows, write depth or participate in raycasting.

The atmosphere root also contains the existing blue pool light. Reflector hides only shaft/glow groups and restores their visibility in finally; the light continues illuminating the reflected piano. Cleanup disposes materials/geometries once. Existing fixed/manual rendering, musical revision, Worker, keyboard and editor lifecycle remain shared. No settings/database/project-format migration or new dependency is introduced.

This is a lightweight artistic approximation of light scattering. It does not implement physical participating-media raymarching or volumetric shadow rays. Do not call it photorealistic or claim measured GPU budgets from geometry counts alone.

## Visual iterations

1. [Initial room](iteration-1/atmosphere-room.png), [whole platform](iteration-1/atmosphere-whole-platform.png): automated pixels passed, but root rejected the shaft as P1 because three sharp nested silhouettes looked like a flat glowing funnel. The perimeter was accepted. [Original test report](iteration-1/report.json).
2. [Revised room](iteration-2/atmosphere-room.png), [whole platform](iteration-2/atmosphere-whole-platform.png): continuous edge falloff, lower density, lighter cyan-blue and mild taper remove the layered boundaries. Root opened the poster, revised room and whole-circle captures together. Visual comparison accepted for the scoped lighting adaptation. [Focused capture report](iteration-2/report.json).

Same deterministic production scene, fixed 1280×800 backing/CSS pixels, resolution=1, time=0.4 s, camera matching each iteration. The poster is 543×498 and is a lighting reference rather than a UI/camera clone. See root [visual QA](../../../design-qa.md).

## Verification

Browser suites ran sequentially with real Chrome/Edge, WebGL, synth playback and native Worker; no successful rendering/playback is mocked. The initial full UI server on 4173 was occupied by parallel work. Atmosphere verification used an isolated temporary config on 4183, with separate `atmosphere-<channel>` output/report paths; it did not stop or reuse the other server.

| Check | Result |
| --- | --- |
| Chrome stage + grand-piano scenarios | **4/4 PASS**, zero retries/skips, 113.6 s. [Report](chrome/report.json). |
| Edge same scenarios | **4/4 PASS**, zero retries/skips, 123.8 s. [Report](edge/report.json). |
| Focused helper/stage unit | **3/3**, two files, independently reviewed resource/quality/visibility contracts. |
| Full unit run | **601/602 PASS, 1 timeout**, zero pending. `packages/engine-ts/test/engine.test.ts` → `replans document when fingering changes` exceeded its existing 5,000 ms timeout. Engine source was not changed by this task. [Full report](unit-full.json); isolated recheck recorded separately below. |
| Isolated engine recheck, unchanged timeout | **6/6 PASS** in the same test file. The previously timed-out replan completed in **1,885 ms**. [Report](unit-engine-recheck.json). The full-run timeout remains in evidence; this is not relabelled as a clean 602/602 run. |
| `npm run typecheck` | PASS. |
| `tsc -p tests/browser/r3d/tsconfig.json --noEmit` | PASS. |
| `npm run lint` | PASS. Root's subsequent focused lint for the adjusted helper test also passed. |
| `git diff --check` | PASS, Windows line-ending notices only. |
| `npm run build` | PASS: buildId `9844320e1b836dc21942a796`, 258 offline resources / 70.60 MiB, engine `60341216864eb0a548fbc66ba2b1848b9bb7b6b2de85c2c1e7f03fbd655bc63a`, runtime 314.0.7. Existing large-chunk warning remains. The build also contains concurrent user rail/menu changes; those functions are outside this lighting acceptance. |

Chrome's same-camera on/off sampling changed 3,963 of 24,320 sky samples and 16,887 of 26,880 lower-floor samples. Repeated identical manual frames have zero delta. The whole-circle boundary has 83 valid pairs, mean summed RGB delta 0.736 / maximum 2.4 (8-bit scale). The samples support, rather than replace, the visual review. Both new shader checks and the existing stage harness record no page/console errors. Compiler precision warnings for tiny floating-point terms remain unfiltered.

The new browser scenario toggles the actual named atmosphere group in the test fixture for a same-preset on/off comparison, verifies changes in sky and floor, exact stability of repeated manual frames, whole-circle fade and 88 keys/fixed dimensions. Existing stage and grand-piano scenarios cover reflections/quality, project and Worker identity through preference changes, playback, committed settings/reload, mobile controls and the four original cameras.

## Reproduce and limits

With 4173 free, use the normal project configuration:

```powershell
Set-Location C:\Projects\pianomotion-studio
$env:PIANOMOTION_BROWSER_CHANNEL = 'chrome'
node node_modules/@playwright/test/cli.js test --config playwright.config.ts tests/browser/stage-environment.spec.ts tests/browser/grand-highway.spec.ts
$env:PIANOMOTION_BROWSER_CHANNEL = 'msedge'
node node_modules/@playwright/test/cli.js test --config playwright.config.ts tests/browser/stage-environment.spec.ts tests/browser/grand-highway.spec.ts
node node_modules/vitest/vitest.mjs run --config vitest.config.ts --maxWorkers=1
npm run typecheck
npm run lint
npm run build
```

Focused stage acceptance does not repeat full production offline, MP4/WebM encoding, physical MIDI/SF2, 13 Python numerical goldens or stress/performance acceptance. Existing art-direction differences (closed interactive note deck, no photographic lid/bench/text reproduction) are intentional. Switch to Studio to remove atmospheric effects, or Low to reduce shell/reflection cost; do not clear site data. The user's local dev server on 5173 stays running.

The final in-app browser control connection failed while trying to re-inspect the user's tab; no new user-tab screenshot is claimed. Real browser screenshots above come from the completed Chrome/Edge scenarios. An HTTP check separately confirmed 5173 returns 200 and serves the revised atmosphere shader; this HTTP check alone is not treated as visual acceptance.
