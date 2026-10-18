# Practice A–B and bookmarks — dev.22, 2026-10-18

## Result and scope

Stage 2 is implemented and locally verified: a Practice rail action opens A–B repeat and named time bookmarks. Desktop supports the existing right dock/overlay; narrow screens use a sheet. New strings cover EN/CS/UK/DE/ES/IT. Existing menu, library, recovery, audio and 3D work remains included in this cumulative release.

Practice metadata is optional in SavedProject, recovery snapshots and JSON packages. It binds to the source MIDI SHA-256 and validates duration, finite times and unique bookmark IDs. Legacy projects without the field remain supported. Metadata edits change the save token without changing the musical revision or replanning. Restore intentionally rebuilds derived plans; their IDs may change while source IDs, notes and revision remain stable.

Repeat plays [A,B), with a minimum span of 0.1 seconds and decimal tolerance. Playback, speed, pause, Stop, crossing notes and pedal state are covered. Play Along navigation and automatic advancement stay within eligible steps; an outside bookmark disables repeat before jumping. Empty-step ranges remain editable. Bookmarks support add, jump, rename and delete, including save, immediate recovery flush and package transfer.

## Orchestration and corrections

GPT-6 Luna Extra High subagents implemented transport/recording, persistence/player integration, shell/localization and browser scenarios. Root reviewed the seams, returned defects, independently ran checks and inspected desktop/mobile screenshots. Handoffs alone did not close acceptance.

Corrections found during integration:

- Atomic SoundFont preparation retains bounded current and loop-head windows together. Prefetch resets at wraps; both preparation and readiness sort/deduplicate windows. Unsorted readiness had caused an endless pause/prepare cycle in the real SF3 test.
- Changing the range during pending preparation invalidates the old Play continuation. Moving a playing loop to an unprepared section waits for samples before restoring voices.
- Legacy negative lead-in windows remain valid. Restoring SoundFont state clears stale additive fallback voices and restores their pedal baseline without duplicating synth-owned voices.
- The bundled Signalsmith scheduler discarded active segments when future wraps were queued. The one-line local patch prunes only through live `currentTime`; README records it, and WASM/license contents are unchanged. [Failing measurement](chrome/recording-before-fix.json) versus the final actual AudioWorklet test in [Edge](edge/report.json).
- Mobile heading shrink/clipping, no-step recovery controls and keyboard scope were corrected. Pause assertions now wait for the diagnostic snapshot to settle before checking that time stays fixed.

## Evidence

| Check | Exact result |
| --- | --- |
| Frozen release full unit suite | **67 files, 639 tests PASS**, 61.86 s; [output](unit.log) |
| Full typecheck + browser project typecheck | **PASS**; [command output](typecheck.log) |
| Full lint + scoped browser lint | **PASS**; [command output](lint.log) |
| Production release build | **PASS**, buildId `155a2fe3de0dde71404b0131`, base `/pianomotion-studio/`, 258 offline files / 70.66 MiB; [output](production-build.log) |
| Edge, frozen release | **9/9 PASS**, 99.31 s; [report](edge/report.json) |
| Chrome, nine unique scenarios | Confirmed by five successful cases in the [integration run](chrome/initial-integration.json), [three final focused cases](chrome/final-focused.json), and [final real SoundFont case](chrome/soundfont-final.json) |

The Chrome integration run also retains failures: a screenshot timeout under concurrent activity, an immediate paused-snapshot comparison, the SF3 readiness defect, and one interrupted case. They are not represented as a green full run. Their affected scenarios were rerun successfully. An earlier post-reload plan-ID assertion was corrected because the existing restore path generates a fresh derived plan.

The nine scenarios cover empty/project File and Export menus, original Play Along navigation, actual Signalsmith output, synth repeat at 0.5×/2×, pause/Stop/disable/invalid bounds, bookmark edit/save/reload/recovery/JSON import/new source, mobile controls/focus/no overflow, default MuseScore SF3 repeat and rail actions. The recording test renders six actual 220/440 Hz sections over two scheduled wraps under production CSP, with no DSP errors. It does not use a fake StretchNode for acceptance.

[Desktop](edge/practice-desktop-loop.png) · [Mobile 390 px](edge/practice-mobile-390.png). Root inspected these images; the mobile title is inside the sheet and controls remain usable.

## Frozen publication source

Checks initially used the shared `C:\Projects\pianomotion-studio` checkout. A parallel, unfinished hand-model selector appeared during verification and failed typecheck. Root created `scratch/release-dev22` from HEAD plus the completed changes, removed only that selector from the copy, and left the original working files untouched. A temporary debug-only block in a 3D test was also removed from the copy after lint reported `any`. Final Edge, types, lint, unit and production checks above use this frozen copy with a private Vite cache on port 4203 and the already installed dependencies.

The release index is populated from the frozen copy; later parallel edits are not swept into the commit. No reset/clean, dependency installation or desktop Python changes were performed.

The user explicitly authorized commit, push and deploy after implementation. This report records local acceptance before publication. The [GitHub Pages workflow](https://github.com/shafranek-js/pianomotion-studio/actions/workflows/deploy-pages.yml) must build the pushed commit, and root verifies the live manifest/bundle and browser behavior separately. Historical notes saying publication was not requested refer to their earlier local cycles.

## Limits

This does not close the whole migration roadmap or the independent full Windows CI matrix. Physical MIDI hardware, weak-device budgets and newly decoded video exports were not accepted by this task. The existing large-chunk build warning remains. The unrelated hand-model selector is deliberately retained as local work outside this publication snapshot.

## Reproduction

```powershell
npm run typecheck
node node_modules/typescript/bin/tsc -p tests/browser/practice-stage2.tsconfig.json --noEmit
npm run lint
npm run test:unit -- --maxWorkers=1
$env:APP_BASE='/pianomotion-studio/'
npm run build
# Free ordinary test port; Chrome and Edge sequentially:
$env:PIANOMOTION_BROWSER_CHANNEL='msedge'
node node_modules/@playwright/test/cli.js test tests/browser/practice-stage2.spec.ts tests/browser/practice-recording-dsp.spec.ts tests/browser/rail-quick-access.spec.ts tests/browser/menu-visibility.spec.ts tests/browser/play-along.spec.ts
```
