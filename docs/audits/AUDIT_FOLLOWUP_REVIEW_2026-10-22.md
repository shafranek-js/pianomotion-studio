# Independent follow-up: SEC-7, CLI-4, ENG-13

Review date: 2026-10-22. Working-tree review; no product edits, staging, commit, push or deployment.

## Verdict

- **SEC-7 accepted as Partially fixed.** The 20-minute / 256 MiB decoded PCM check runs after decode and before waveform generation/return. It bounds accepted recordings, not the transient allocation inside decodeAudioData. The pre-decode memory risk remains open as explicitly reported.
- **ENG-13 accepted within the stated evidence boundary.** Python and TS propagate marker-parser failures through the song to sourceParseErrors. The Python integration test injects a parser-boundary failure; no naturally occurring otherwise-importable failing MIDI is demonstrated. All 12 source hashes match the manifest, which matches EMBEDDED_MANIFEST; engineVersion is ace1241d24a1b07f25c3098f9ad4985d5dbe3d86ddaf847bb5a50b30ac6deb03.
- **CLI-4 partially accepted; two remaining findings below.** Bootstrap retry creates a new runtime promise. Application cleanup is added, and Pixi context-loss status reporting exists. Full 3D reporting and cleanup-error preservation are not covered.

## Remaining CLI-4 findings

### P2: context-loss status handlers cover only the Pixi canvas

`apps/client/src/render/pianoScene.ts:242` attaches the application callbacks to app.canvas. The visible Three renderer has a separate canvas (`apps/client/src/render3d/pianoScene3d.ts:260`); these callbacks are not forwarded to it. Context events do not bubble from that separate canvas into app.canvas.

The browser regression uses `querySelector("#piano-canvas-container canvas")` (webgl-context-loss.spec.ts:8), selecting the first canvas, and asserts only status text. It does not establish reporting or continued rendering for loss of the visible 3D renderer. Three has its own internal context handlers; absence of these application callbacks does not prove Three cannot restore itself.

Forward loss/restoration callbacks to the 3D canvas with lifecycle cleanup. Exercise explicit 2D and visible 3D selectors, and check rendered/playback state after restoration in addition to status text.

### P3: scene cleanup can replace the original initialization error

`disposeFailedScene` calls scene.destroy() outside its try/catch (`pianoScene.ts:134–136`). When scene creation succeeded but setupResizeObserver/resize failed, a failure inside scene.destroy() escapes and replaces the original startup exception. Only the app.destroy branch currently preserves it; the new test likewise covers cleanup throwing only for that branch.

Guard scene cleanup as well and add a throwing-scene.destroy regression. This is a source-established exception-ordering defect, not a reproduced real WebGL failure.

## Independent checks

- Vitest: recording.test.ts, sceneCleanup.test.ts, midi-marker-diagnostics.test.ts — **38 passed / 3 files**.
- Separate .venv-test Python, PYTHONPATH=python-core: test_marker_diagnostics.py — **2 passed**.
- Manifest: **12/12 hashes**, EMBEDDED_MANIFEST equality.
- git diff --check: exit 0 (line-ending warnings only).

The full PR gate, full suite, browser scenarios and production artifact were not rerun in this review; their reported results remain the implementer's evidence. The extra file-scoped timeout change in tests/unit/release-assets.test.ts is separate test infrastructure and should be accounted for in commit scope. motion-playback.spec.ts currently has an empty git diff; the earlier diagnostic-only additions were removed. ORCHESTRATION.md contains the separate playback-investigation notes and should remain outside these fixes' commits.

## CLI-4 recheck after the remaining fixes

**CLI-4 accepted within the tested scope.** Both findings above describe the previous tree and are now closed: PianoScene forwards the callbacks to PianoScene3D, which registers listeners for the interactive canvas and removes them on destroy. Fixed/export viewports do not register these callbacks. disposeFailedScene now guards both cleanup branches, preserving the original initialization error.

Independently executed:

- sceneCleanup.test.ts: **4/4 passed**, including throwing scene.destroy.
- webgl-context-loss.spec.ts, Chrome, isolated port 4294: **2/2 passed**, explicit Pixi and visible Three canvas selectors, no skips, 42.2 seconds.
- verify:release: build **19e8ff10db89cd1765ccc5db**, **258 files / 74,129,974 bytes**.
- git diff --check: exit 0.

The browser assertions establish application loss/restore status reporting and the continued presence/size of the 3D canvas, rather than pixel-level rendering correctness for every GPU failure. Inspected gate logs at .ci-local/2026-10-22T18-00-08-620Z confirm 741 tests / 96 files, Python 40 passed / 1 skipped, native parity PASS, and 11 passing smoke tests; the full gate was not independently repeated. SEC-7 remains accepted as Partially fixed and ENG-13 retains the parser-injection evidence boundary. No product edits, commit, push or deployment during this recheck.
