# Concert stage — 0.1.0-dev.18, 2026-10-18

Checkout: `C:\Projects\pianomotion-studio`. Work is layered over the dirty dev.14–17 tree and concurrent session recovery, waveform, play-along and menu edits. No reset, staging, commit, push or deploy. Existing piano shape, casing normals, branding, musical algorithms, data formats and 13 numerical goldens are preserved.

## Implementation

- `render3d/pianoStage3d.ts` owns a radius-80 circle at floorY=-20, graphite wood texture, physical material, radial transparency from 70% radius, lighting and a real Three.js Reflector pass. The reflection uses five blur taps and the same outer fade; the floor is hidden during the reflected render. There is no inverted duplicate piano.
- Concert uses warm primary light, cool rim and blue rear floor pool. Studio uses neutral fill. One primary light owns the 2048² shadow map; secondary lights do not generate shadow maps.
- Reflection target: Low 256²; Auto 256² at viewport width ≤900, otherwise 512²; High 1024². Reflection=0 hides the Reflector and skips its offscreen pass. Changing settings/viewport resizes the target only when needed. The main canvas resolution and camera presets remain independent.
- `settings/stageAppearance.ts` normalizes invalid/legacy values, caps brightness to 0.5–1.5 and reflection to 0–1, and returns detached values. Defaults: Concert / 1 / 0.28 / Auto. No new project schema or IndexedDB version is needed.
- Inspector → Scene → 3D environment exposes preset, brightness, reflection and quality in six locales. Player applies changes immediately, debounces commits by 160 ms, preserves newer preview values against older commit notifications, and flushes pending preference writes on unmount. A persistence failure is reported; musical data is not rewritten.
- Display settings also flow into the frozen export snapshot and isolated fixed/manual scene. No ticker/ResizeObserver is introduced in fixed mode. Resource disposal and exception cleanup restore render target (including null), floor visibility, XR and shadow-map update state.

## Verification results

Windows, Node 24.14.0; Chrome and Microsoft Edge installed channels, one browser worker, sequential suites. No audio/Worker/render success mocks substitute the browser checks.

| Check | Actual result |
| --- | --- |
| Full unit, `vitest run --config vitest.config.ts --maxWorkers=1` | **599/599, 61 files**, success=true. [JSON](unit.json). |
| Isolated `videoExporter.test.ts` | **10/10**. Earlier simultaneous browser/unit run had 589 passing tests and a forks-worker startup timeout for this file; isolated and full quiet reruns passed. |
| `npm run typecheck` | PASS. |
| `tsc -p tests/browser/r3d/tsconfig.json --noEmit` | PASS, including the production-scene harness. |
| Scoped ESLint: stage/scene/settings/Player/Inspector/i18n/export bridge | PASS. |
| Final full `npm run lint` | **PASS** on repeat after concurrent menu edits settled. The preceding run reported two errors in `studio/StudioShell.tsx` (`set-state-in-effect` and unused `renderMenuPopover`); those edits were preserved and changed independently. Root did not repair menu code as part of this task. No claim of a green full CI. |
| `git diff --check` | PASS; Windows line-ending notices only. |
| `npm run build` | Final repeat PASS at 17:51 UTC: buildId `e356e769e95dcd18e5e713a6`, engine `60341216864eb0a548fbc66ba2b1848b9bb7b6b2de85c2c1e7f03fbd655bc63a`, runtime 314.0.7, 259 offline resources / 70.66 MiB. Rebuilt after concurrent menu edits; their separate functional acceptance is outside this task. Existing large-JS-chunk warning remains. |
| Chrome, stage + grand-highway | **3/3**, zero skips/retries: [report](chrome/report.json). |
| Edge, same suites | **3/3**, zero skips/retries: [report](edge/report.json). Includes the 28% slider-step regression. |
| Chrome final preferences rerun | **1/1**, zero skips/retries: [report](chrome/preferences-final.json). Includes exact 28% native input/accessibility value, playback/persistence/mobile and final screenshots. |

The stage harness records no page errors or console errors. Some browser shader compiler precision warnings are emitted for extremely small floating-point terms; they do not fail compilation. They have not been suppressed. The original test harness favicon 404 was repaired with an explicit empty favicon, not filtered from console errors.

## What the browser checks prove

- All 88 production keys; real WebGL context; fixed 1280×800 backing dimensions survive quality changes. Existing curved note surface, smooth cheeks, gold branding and all four fixed cameras pass together with the new stage.
- Preset and brightness changes alter visible floor pixels. Raycasts exclude foreground piano geometry; a denser world grid includes the exposed floor below the apron rather than skipping thin reflections.
- Chrome: 1,108 exposed floor probes, 1,104 changed by Concert→Studio; 254 changed by brightness; 1,107 changed by reflection on/off. Identical manual frames have zero delta; advancing notes from 0.2 to 1.05 s changes 13 narrow reflection probes, summed RGB delta 457. Most reflected note geometry is physically occluded by the piano, so a large moving floor region is not required.
- At the full-circle perimeter, 83 valid sample pairs: mean summed RGB boundary delta 0.704, max 2.4 (8-bit scale). This complements the [wide screenshot](chrome/stage-wide-overview.png); it does not prove every camera/GPU combination.
- Live synth playback keeps advancing while all four settings change. Project ID, revision, engine version, pending=false and calculation Worker count remain stable. IndexedDB commits the final values; reload restores them. Mobile 390×844 shows all four controls without page-level horizontal overflow.
- Root inspected the actual local application and compared the poster reference, [room view](chrome/stage-room-concert.png), floor/reflection details and [mobile Inspector](chrome/stage-settings-mobile.png). [Visual QA](../../../design-qa.md).

## Reproduce

```powershell
Set-Location C:\Projects\pianomotion-studio
node node_modules/vitest/vitest.mjs run --config vitest.config.ts --maxWorkers=1
npm run typecheck
npm run lint
node node_modules/typescript/bin/tsc -p tests/browser/r3d/tsconfig.json --noEmit
$env:PIANOMOTION_BROWSER_CHANNEL = 'chrome'
node node_modules/@playwright/test/cli.js test --config playwright.config.ts tests/browser/stage-environment.spec.ts tests/browser/grand-highway.spec.ts
$env:PIANOMOTION_BROWSER_CHANNEL = 'msedge'
node node_modules/@playwright/test/cli.js test --config playwright.config.ts tests/browser/stage-environment.spec.ts tests/browser/grand-highway.spec.ts
npm run build
```

Run the browser commands sequentially; their dedicated server uses 4173. The user's dev server on 5173 remains running. The room/overview evidence cameras exist only in the test harness; the product's existing camera controls are retained.

## Boundaries and recovery

This accepts the scoped stage behavior and visual adaptation. It does **not** re-run the full media encoding, production offline restore/update, Python/13-golden, physical MIDI/SF2 or 2k/10k/50k stress suites, nor certify low-end GPU frame rates or measured total GPU memory. Fixed/manual rendering is verified; complete new MP4/WebM exports are not claimed. The poster is a lighting reference, not a photorealistic reproduction target.

For a slow GPU, choose Low or set reflection to zero; the physical floor and lighting stay available. For a narrow rollback, disconnect only the stageAppearance Inspector callback and display bridge, then revert the PianoStage3D integration coherently. Preserve previous casing/highway/branding changes, musical data and concurrent user edits. Never delete site data or IndexedDB as a repair. Old settings without stageAppearance continue to load with defaults.
