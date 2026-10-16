# Local dev.5 verification — 2026-10-16

Checkout: `C:\Projects\pianomotion-studio`, Windows, local uncommitted changes above `aaa3cf6f78a442aafdab4849730edf1ffd7a4a6e`. No commit, push or deployment is part of this run. The user's `soundfonts/` is read-only input and is not a distributable fixture.

## Animation buffering

The original request threshold was only 1.5 song-seconds and playback could resume with 0.2 seconds of coverage. At faster playback or a slow Worker, that reserve was consumed before the next window arrived. Missing event anchors could also cause a later request to skip an earlier continuous-coverage gap.

The player now starts prefetch during lead-in, maintains an 8-second real-time target that grows with measured Worker latency (up to 24 song-seconds retained), and requests the earliest missing section with overlap. Each application request remains bounded to four seconds / 200 poses. Verified per-hand coverage and required event points remain mandatory. Automatic resumption needs a useful speed/latency-aware reserve; manual Pause/Stop cancel the intent to resume. A truncated response at its final endpoint gets a bounded overlap retry rather than a spurious capacity error.

| Real Worker scenario | Chrome | Edge |
| --- | --- | --- |
| Every sample-motion request delayed 1,500 ms; advance beyond song second 25 | PASS: 0 buffering pauses, 9 requests, RTT estimate 3,104 ms | PASS: 0 buffering pauses, 9 requests, RTT estimate 2,842 ms |
| Seek to uncovered second 37, then manually Pause while preparing | PASS: remains at 37, no auto-resume | PASS: remains at 37, no auto-resume |
| Speed 2×, advance beyond song second 25, then Stop | PASS: 0 buffering pauses | PASS: 0 buffering pauses |

Raw reports: `motion-chrome.json`, `motion-msedge.json`, `motion-double-speed-chrome.json`, `motion-double-speed-msedge.json`; decoded delayed-run metrics are adjacent. A first 2× run recorded one pause while another agent was modifying runtime modules. The frozen-source rerun passed; HMR is a plausible explanation, not a demonstrated cause. That failed run is not counted as a pass. The retained `lastPause` snapshot records range/Worker state if another failure occurs.

These checks use a real Worker and real transport. They do not promise uninterrupted playback if generation is consistently slower than consumption, after an uncovered seek, or under unmeasured dense workloads. Such cases still prepare explicitly rather than display fabricated hand poses.

## SF2 and console errors

Both Chrome and Edge passed all five focused native scenarios: existing mono SF2 activation/reload; linked stereo WAV plus MP4 and WebM native demux/decode; genuine IndexedDB v1 migration; write/delete success followed by transaction abort; cancellation of parser/hash Workers. Raw reports: `audio-chrome.json`, `audio-msedge.json`. Stereo metrics are embedded as JSON attachments in those reports; both container formats were actually encoded and decoded, with separate non-silent channels.

The source `onended` callback now has a complete per-channel cleanup implementation, including mixed loop modes and mode-3 tails. The unbuilt development Service Worker retires itself without requesting a release manifest, and startup unregisters only this application's exact scope/script. It never deletes site data. Production release caching remains independently checked below.

## Large files and real bank

Chrome passed the 128/512/1024 MiB cases and the over-limit rejection in `soundfont-chrome-first.json`. That first run also contains the initial real-bank failure; it is retained rather than rewritten as fully green. Edge passed all four size/limit cases in `soundfont-msedge.json`.

Each generated bank is a valid synthetic stereo SF2 with expanded unreferenced PCM. Browser Worker SHA-256 agrees with a separate Node streaming hash; IndexedDB stores the actual File/Blob and restores it after page reload. Production import did not materialize bank PCM. Only the two referenced samples were decoded: **132,304 bytes**, with zero pending bytes, independent of file size. This does not establish throughput for an arbitrary dense one-GiB active sample set.

| Input size | Chrome measured operation time | Edge measured operation time | Chrome sampled private-memory peak | Edge sampled private-memory peak |
| --- | --- | --- | --- | --- |
| 128 MiB | 32,993 ms | 3,321 ms | 563,564,544 bytes | 568,528,896 bytes |
| 512 MiB | 5,844 ms | 4,612 ms | 573,964,288 bytes | 589,869,056 bytes |
| 1 GiB | 9,131 ms | 7,379 ms | 567,148,544 bytes | 569,839,616 bytes |

Operation timing starts after file generation/hash/upload and includes browser measurement setup, import, hash, commit, reload and decode. The first Chrome case includes cold module work; these are observed runs, not standardized benchmarks. Process memory is sampled approximately every two seconds for this isolated browser's PIDs; it is not the exact instantaneous peak or the sample-cache counter. No sampling errors occurred. The 256 MiB budget covers decoded/preparing sample data, not the whole browser process.

The user's read-only `Nice-Steinway-Lite-v3.0.sf2` is 74,398,266 bytes with SHA-256 `6f2e465b3ec4a6116c6e23b762a6ad4148c9f44f4660a7503f0d0b89cc82fe9b`; its hash was rechecked after the tests. Both browsers now pass upload, active output, playback, save/reload and independent stereo decode: `user-bank-chrome.json`, `user-bank-msedge.json`. It has 29 reciprocal pairs; 26 pairs have unequal PCM lengths and all 29 have different relative loop starts. Individual bounds and 44.1 kHz rates are valid. [SF2 2.04 page 29](https://www.synthfont.com/sfspec24.pdf#page=29) specifies synchronized playback, right-side pitch and per-channel non-pitch generators, without an equal-frame-count rule. The parser and synth no longer impose that extra equality; malformed links/bounds and unsupported rates still fail. The bank has no explicit sampleModes operator in its 2,760 sample-bearing zones; it is not evidence for looping behavior. Synthetic mode 0/1/3 tests remain the looping evidence. Exact commercial timbre parity and subjective listening remain open.

## Static, numerical and production checks

- Final full unit run: **447/447**, 34 files, one worker, `unit-dev5.json`.
- `npm run typecheck` and `npm run lint`: PASS.
- `npm run test:parity` in Chrome: **15/15**, including all **13 frozen fixtures with zero differences**, cancellation and corrupt input; `parity-chrome.json`. No expected numerical values were edited.
- Genuine Worker replan, restore, seek/stale identity tests: **1/1 in each browser**, `motion-streaming-chrome.json`, `motion-streaming-msedge.json`.
- `npm run build`, base `/`: PASS; release `7668481b5fc62aee904ddde3`, 88 offline files, 30.49 MiB; engine remains `83fde5039dd70360c29aa5a3edbb07fc2f024528c76330b42bc55e195cb8fbc7`. Vite retains the existing large-chunk warning (main JS approximately 1.47 MB before gzip).

Production offline: **1/1 in each browser**, `offline-chrome.json` and `offline-msedge.json`. A saved stereo bank is restored in a new page after closing the original and switching the context offline; both new SF2 Workers load and actual SF2 voice sources start. This tests base `/`; the previous audit's subdirectory/two-release/cache-failure tests are historical and were not rerun in this slice.

Python source is unchanged in this cycle; the prior 28-test Python run remains separate from the fresh browser parity result. Scoped lint of the added/modified browser/VM tests also passes after removal of one unused import. CI now includes the sequential large-file group and excludes generated bank inputs from uploaded artifacts; remote CI has not been run for these uncommitted changes. The real-user-bank case is explicitly conditional in CI because its private source is not bundled. Generated large size-test inputs were removed after the runs; the source fixture/generator remains, alongside all JSON evidence. The private user bank remains untouched.

Subjective listening, physical MIDI hardware and 10k/50k musical-load acceptance remain separate. Existing project/package compatibility and baseline UI acceptance have not been relabeled as a new exhaustive release sign-off.

## Reproduction

Use PowerShell in the canonical checkout; set `$env:PIANOMOTION_BROWSER_CHANNEL='chrome'` or `'msedge'`. Run browser groups sequentially and wait for the command to exit before starting the next group; a browser teardown can outlive its final test result. An early Edge streaming attempt encountered occupied port 4173 during preceding Chrome teardown; the rerun after exit passed.

```
npm run test:unit -- --maxWorkers=1 --reporter=json --outputFile=test-results/reports/unit-dev5.json
npm run typecheck
npm run lint
npm run test:worker -- tests/browser/motion-playback.spec.ts
npm run test:worker -- tests/browser/motion-streaming.spec.ts
npm run test:parity
npm run test:audio -- tests/browser/audio-output.spec.ts tests/browser/soundfont-stereo.spec.ts tests/browser/soundfont-storage.spec.ts
npm run test:soundfont
npm run build
npm run test:offline -- tests/browser/soundfont-offline.spec.ts
```

The real bank defaults to `soundfonts/Nice-Steinway-Lite-v3.0.sf2`; `PIANOMOTION_TEST_SF2` can point to another private local bank. Size checks and the real-bank reruns were separate invocations in this record, so use the individual JSON reports, not a sum presented as one full run. No source bank or generated large input is part of the release. Local dev server `http://127.0.0.1:5176/` returned HTTP 200 after final edits. Version is 0.1.0-dev.5 across root/client/contracts manifests and lockfile; no Git publication was performed.
