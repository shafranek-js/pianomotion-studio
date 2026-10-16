# SoundFont stereo and large-bank implementation — dev.5

Working checkout: `C:\Projects\pianomotion-studio`. Target browsers: Windows Chrome/Edge. The local change implements linked stereo PCM SF2 and File/Blob input up to 1 GiB. Deployment is not part of this change.

## Design and ownership

- Root owns shared types, Transport/Player integration, dependencies/lockfile, version, independent checks and documentation.
- `sf2_blob_storage` (GPT-6 Luna Extra High) owns parser/hash workers, metadata index, transactional Blob asset-store migration and Settings import/cancellation. Its native IndexedDB browser tests are separate from mocked unit tests.
- `sf2_stereo_synth` (GPT-6 Luna Extra High) owns paired voices, shared sample provider, output window readiness and factory preparation.
- `sf2_export_checks` (GPT-6 Luna Extra High) owns immutable export Blob identity, offline scheduling and native stereo media tests.

No source bank is bundled. The untracked `soundfonts/Nice-Steinway-Lite-v3.0.sf2` belongs to the user and remains read-only. Large synthetic test banks are generated under ignored `test-results/` and were removed after verification to reclaim space; the tests regenerate them. Media outputs remain ignored and metrics are retained with the evidence.

## Internal contracts

- `Sf2SoundFont.sampleSource` indexes immutable Blob PCM by byte offset and sample count, with optional verified content hash for shared live/export caching. `rawSampleData` remains only for buffer/legacy test compatibility.
- `parseSf2Async` accepts Blob/ArrayBuffer/Uint8Array with cancellation and phase/byte progress. `computeSha256Hex` accepts Blob/ArrayBuffer and hashes 4 MiB chunks in a Worker. Full-file ArrayBuffer reads are absent from production import/restore/export.
- `SoundFontSampleProvider` shares decode/cache work across synth instances, reserves conversion memory, pins leases, deduplicates pending reads and rejects capacity errors before allocation.
- `PerformanceOutput.prepareWindow/isWindowPrepared` includes state held at the window start and upcoming press events. Transport freezes the clock for preparation, rejects stale completion and honors Pause/Stop/seek/replan/dispose.
- Export identity holds an immutable Blob plus SHA asset ID, replacing full-bank byte copies. Offline and live use the same stereo synth and sample cache.

## Limits and compatibility

Input: 1 GiB. Combined INFO/pdta metadata: 16 MiB. Decoded/preparing sample budget: 256 MiB shared per tab; inactive LRU: 64 MiB. These are explicit application policies, not SF2 or total-process memory limits. Larger simultaneous active sets fail clearly. SF3/ROM/linkedSample 8 and the previously unsupported full-SF2 features remain outside this slice. Project packages remain v2; musical engine/goldens are unchanged.

## Verification status

Current automatic evidence: 447 unit tests pass; typecheck/lint pass; Chrome and Edge pass native mono/stereo audio, WAV/MP4/WebM decode, genuine IndexedDB migration/abort and parser/hash cancellation. Both pass real File IO/hash/commit/reopen at 128/512/1024 MiB and rejection above 1 GiB before source reads. Both pass activation, playback and restore of the read-only Nice Steinway bank. The initial real-bank failure exposed an excessive equal-length/loop-offset rule, which was corrected with focused parser/synth regressions; the original SF2 bytes remain unchanged. The bank's zones do not explicitly set sampleModes, so this bank does not verify continuous looping; modes 0/1/3 have separate synthetic coverage.

Animation buffering repair: both browsers pass delayed real-Worker playback (1,500 ms added to each motion request), manual Pause after an uncovered seek, and playback at 2×. Real Worker replan/restore/stale-response scenarios pass in both. All 13 frozen numerical fixtures pass in Chrome with zero differences, plus Worker cancellation/corrupt-input scenarios. Production build and Chrome/Edge offline restoration of the bank, new hash/parse Workers and actual stereo voice starts pass. The [exact run record](evidence/sf2-motion-2026-10-16/VERIFICATION.md) retains commands, raw results, initial failures and limits.

Synthetic size tests expand unreferenced PCM and prove real file IO/hash/commit/restore at that file size; they do not establish arbitrary one-GiB dense active-set performance. Private-process samples and managed-cache counters must be distinguished. Compatibility-only ArrayBuffer APIs may still copy caller-provided buffers; the production File/Blob path does not use them.

Manual subjective listening remains a separate user check even after native decode tests pass. Existing hardware MIDI and 10k/50k musical-load limits are unaffected.
