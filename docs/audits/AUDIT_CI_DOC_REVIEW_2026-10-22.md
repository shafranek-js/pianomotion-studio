# Independent review: CI-2, DOC-1, DOC-2

Working-tree review on 2026-10-22. No product changes, commit, push or deployment.

## Results

CI-2 coverage is established: tsconfig.tests.json includes 66 test files (54 browser, 8 unit, and supporting declarations/config files), and both root test typecheck and ESLint passed independently. noImplicitAny=false and the any-based runtime-module/snapshot declarations are real boundaries; this is not complete strict typing of every runtime value. No root TSX files currently exist.

Three corrections remain:

1. **CI-2 — invalid unused engine path mapping.** tsconfig.tests.json maps @handthesia/engine-ts to ../../packages/engine-ts/src/index.ts. Relative to this root config, that is C:\packages\engine-ts\src\index.ts, which does not exist. TypeScript's resolver currently falls back to the workspace package, successfully resolving C:/Projects/pianomotion/packages/engine-ts/src/index.ts. Current root tests do not directly import this alias, so a green gate does not exercise the bad mapping. Use ./packages/engine-ts/src/index.ts or remove the unnecessary override.
2. **DOC-1 — unsupported standalone audio-export instructions remain.** USER_GUIDE.md:78–80 still advertises separate master audio export and a downloadable 16-bit RIFF WAV. StudioShell's export menu offers fingered MIDI, project package and video, with no separate audio-export action. videoExporter uses createWav:false and encodes audio into the selected video container (AAC for MP4 / Opus for WebM). Describe embedded video audio and distinguish any internal WAV utilities from an available user feature. The original drag/drop, MediaRecorder, skins, fixture-generator and version-documentation corrections are otherwise present.
3. **DOC-2 — broken licence link.** PROVENANCE.md links MuseScore_General_License.md relative to docs/, but the file is docs/licenses/MuseScore_General_License.md. Correct the link to licenses/MuseScore_General_License.md.

DOC-2's substantive status is appropriately **Partially fixed**: the new provenance record does not claim permissions for the upstream engine or unidentified media and explicitly preserves the unresolved release gate. No independent determination of external legal rights was made in this review.

The full PR gate and numerical/browser suites were not rerun. git diff --check passed with line-ending warnings only. Existing acceptance of SEC-7/CLI-4/ENG-13 was not reopened; ORCHESTRATION.md remains the separate playback-investigation change.

## Corrections applied and verified

At the user's request all three corrections were applied: root-relative engine mapping, video-embedded AAC/Opus audio instructions using the exact Audio (Master) UI label with no standalone WAV promise, and the existing docs/licenses/ MuseScore licence target.

Independent checks after edits: root test typecheck and ESLint both exited 0; TypeScript resolves the engine mapping directly to this checkout with zero failed lookups; the licence target exists; git diff --check exited 0. CI-2 and the reviewed DOC-1 corrections are accepted with their recorded typing scope. DOC-2 remains accepted as Partially fixed documentation; unresolved permissions/release conditions remain unchanged. No full gate, commit, push or deployment was performed for these three small corrections.
