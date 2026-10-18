# Browser CI adaptation — 2026-10-18

Base: `4e51283f3611cce66f58342a62099b50011fc2cf`, published app `0.1.0-dev.13`.
Local target: `0.1.0-dev.14`, including the offline clock repair below.
Windows; Chrome `155.0.8059.80`, Edge `155.0.4283.45`.
Scope: browser tests/helpers, one runtime SoundFont clock guard and its regression
tests, synchronized workspace/lockfile versions and release documentation.
No musical algorithm, golden, third-party dependency version, retry count or timeout changed.

## Repairs and acceptance

- Retained 2D/3D canvases are selected by dimension for identity/editing and by
  visibility for readiness. The dedicated transition test verifies both canvas
  identities, one visible renderer, one analysis Worker, playback and Undo/Redo.
- Explicit empty boot prevents the automatic anthem from racing file/package
  imports. Recovery still reads the original session and original MIDI bytes.
- UI scenarios explicitly select real synth/2D through the product controls;
  separate default-bank/3D cases retain those real implementations. This avoids
  unrelated SF3 preparation/3D load dominating every UI/storage assertion.
- The Projects panel melody button uses its current accessible name. The profile
  test edits a named anatomy field, accounts for native range step snapping and
  verifies committed profile revision/anatomy. Painted-note selection waits for
  the dispatched wheel event to change the editor view time.
- Python parity selects Python and the canonical `default` pianist rather than
  the product's Virtuoso preset, and checks actual Worker URLs. Production PWA
  setup reads committed IndexedDB settings without development module imports,
  suppresses the default song during cache-only setup, and explicitly verifies
  Python Workers during online analysis, offline recovery and new MIDI import.
- SF2 transaction tests now use a valid shared bank and abort the current
  `asset-metadata` store, explicitly observing request success and transaction
  abort. The previous handmade RIFF was invalid and the legacy `assets` hook
  never intercepted a new-format write.
- Real audio acceptance exposed an independent runtime race: `noteOn` resumed
  an intentionally suspended OfflineAudioContext inside the renderer's preparation
  loop. Live auto-resume is preserved; offline clock ownership now stays with
  the exporter. A new parameterized unit test failed before this fix.

| Check | Result |
| --- | --- |
| Chrome UI (`playwright.config.ts`, dev.13 + harness fixes) | **26/26 PASS**, 175.49 s; no skips/retries |
| Edge UI (`playwright.config.ts`, dev.13 + harness fixes) | **26/26 PASS**, 194.35 s; no skips/retries |
| Chrome UI smoke after runtime fix/version bump (dev.14) | **5/5 PASS**, 31.41 s: default/empty boot, versioned log, editor/history, 2D/3D transitions |
| Edge UI smoke after runtime fix/version bump (dev.14) | **5/5 PASS**, 35.10 s; no skips/retries |
| Chrome real Workers | 5 core cases PASS, including both engines/13 goldens; 15 Pyodide cases PASS after correcting reference-profile setup |
| Chrome production PWA (dev.13 + harness fixes) | **11/11 PASS**, 121.87 s; no skips/retries |
| Edge production PWA (dev.14) | **11/11 PASS**, 128.78 s; no skips/retries |
| Chrome audio (dev.14) | **7/7 PASS**, 75.52 s; includes real SF2/SF3 WAV, MP4 and WebM |
| Edge audio (dev.14) | **7/7 PASS**, 84.91 s; no skips/retries |
| Chrome DSP/100-note regression repeated after fix | **5/5 PASS**, 33.81 s; pitches within 5 cents and markers within 20 ms |
| Full unit suite (dev.14) | **575/575 PASS**, 54 files, one worker |
| Static checks/build (dev.14) | Typecheck, lint and build PASS; release `7cb60a6490fe504a10d9b8d3`, 258 assets / 70.56 MiB |

UI evidence: [Chrome](ui-chrome.json), [Edge](ui-msedge.json).
Post-fix dev.14 UI: [Chrome](ui-smoke-dev14-chrome.json), [Edge](ui-smoke-dev14-msedge.json).
Audio: [Chrome](audio-chrome.json), [Edge](audio-msedge.json),
[repeated clock regression](clock-repeat-chrome.json).
PWA: [Chrome](pwa-chrome.json), [Edge](pwa-msedge.json), [initial failure](pwa-initial.json).
Worker evidence: [initial combined run](worker-initial.json),
[corrected Pyodide run](pyodide-chrome.json). The initial combined run stopped its
serial Pyodide group after one profile-mismatch failure; its 14 unexecuted cases
are not counted as passes. The corrected focused run executed all 15 cases with
zero skips, including all 13 unchanged goldens.
Run groups sequentially with `PIANOMOTION_BROWSER_CHANNEL=chrome` or `msedge`.
Setup and acceptance boundaries: [browser README](../../../tests/browser/README.md).

## Earlier failures and remaining gate

The original failed run `39070604185` had 21 UI failures in each browser,
including ambiguous canvas selection. During the user's parallel localization
work an intermediate local run also observed changing dialog labels and a
temporary `editorShortcuts` reference error. The user subsequently published
dev.13; final results above use that stable source plus these test repairs.
An intermediate profile assertion expected an unsnapped range value, and an
intermediate click used pre-scroll geometry; both were corrected at the harness.

The offline audio fault was reproduced in two real tests, then again on repeat
3 before the fix. Diagnostic state at failure: event 64/199, clock 1.3177324263s,
next event 0.975s, context already `running` during preparation. Those earlier
partial runs are failures, not acceptance. Post-fix audio suites and all five
repeats above are clean. Temporary detailed error instrumentation was removed;
the user-facing error message stays unchanged.

Commands used for final acceptance (set `PIANOMOTION_BROWSER_CHANNEL` per row):

```powershell
node node_modules/@playwright/test/cli.js test --config playwright.config.ts
node node_modules/@playwright/test/cli.js test --config playwright.worker.config.ts
# After fixing the old Pyodide setup, rerun that entire serial group:
node node_modules/@playwright/test/cli.js test --config playwright.worker.config.ts tests/browser/parity-m1.spec.ts
node node_modules/@playwright/test/cli.js test --config playwright.preview.config.ts
node node_modules/@playwright/test/cli.js test --config playwright.audio.config.ts
node node_modules/@playwright/test/cli.js test --config playwright.audio.config.ts tests/browser/audio-dsp.spec.ts --repeat-each=5
node node_modules/vitest/vitest.mjs run --config vitest.config.ts --maxWorkers=1
npm run typecheck
npm run lint
npm run build
git diff --check
```

The initial real-Worker/core matrix and full 26-case UI groups ran against
dev.13 plus harness changes. The narrow runtime fix and synchronized dev.14
were subsequently checked by the complete unit/audio suites, five DSP repeats,
fresh typecheck/lint/build, full Edge production PWA and focused UI in both
browsers. Whole UI/Worker groups were not rerun redundantly after that audio-only
guard; exact test versions are distinguished above.

Remote dev.13 run `39103623075` remains a historical failed result; these local
changes have not been pushed or run by GitHub. Local UI acceptance does not prove
the entire Windows CI matrix, all large-bank/media suites or release readiness.
No commit, push, deployment, workflow disabling or notification changes were made.
