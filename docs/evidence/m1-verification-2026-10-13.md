# M1 browser verification and parity evidence — 2026-10-13

This document records the browser execution results, desktop parity verification, Pyodide worker lifecycle checks, and runtime performance benchmarks for Hand-thesia Web Milestone M1 (W012, W013, W014).

All tests were executed in real headless Chromium via Playwright against the local Vite development server (`http://127.0.0.1:4173`) running self-hosted Pyodide 314.0.7 and the packaged `handthesia_core` Python package.

---

## 1. Automated test suite execution summary

Command runs and exact pass/fail counts executed on 2026-10-13:

| Command | Status | Details | Duration |
|---|---|---|---|
| `npm.cmd run typecheck` | **PASS** (exit 0) | `tsc -b apps/client/tsconfig.json && tsc -p packages/contracts/tsconfig.json && tsc -p tsconfig.tools.json` | 4.2s |
| `npm.cmd run lint` | **PASS** (exit 0) | ESLint clean across client, contracts, tool configs | 3.1s |
| `npm.cmd run test:unit` | **PASS** (exit 0) | Vitest contract unit tests: 1 test file, 18 tests passed | 1.7s |
| `npm.cmd run test:parity` | **PASS** (exit 0) | Playwright parity suite: 1 test file, 15 tests passed | 21.3s |
| `npm.cmd run test:browser` | **PASS** (exit 0) | Playwright full browser suite: 2 test files, 16 tests passed | 23.5s |

### Test Breakdown

1. **`tests/browser/bootstrap.spec.ts`** (1 test passed):
   - Verified page title: `"Hand-thesia Web · MIDI diagnostics"`
   - Verified primary heading (h1): `"MIDI analysis diagnostics"`
   - Verified accessible status region (`role="status"`): `"Pyodide stays idle until you start an analysis."`
   - Verified zero unhandled page errors on load.

2. **`tests/browser/parity-m1.spec.ts`** (15 tests passed):
   - 13 fixture parity tests covering every fixture in `web/tests/fixtures/manifest.json`.
   - 1 cancellation test verifying immediate worker termination and job disposal.
   - 1 invalid/corrupt MIDI rejection test verifying safe error handling without crashing the Web Worker.

---

## 2. Desktop Parity Verification (W012 / W013)

Each fixture was analyzed in Chromium via the dedicated Pyodide Web Worker. The resulting `M1AnalyzeMidiResult` was retrieved and compared against the immutable M0 golden observation (`web/tests/fixtures/golden/<fixtureId>.json`) using `compareM1ResultToGolden`.

Tolerance criteria:
- Event onset / release time: $\pm 0.001$ s (1 ms)
- Raw white-key coordinates: $\pm 0.01$ white-key widths
- Physical hand coordinates: $\pm 0.01$ white-key widths

### Parity Matrix across All 13 Fixtures

| Fixture ID | Category | Expected Status | Actual Status | Source Notes | Normalized Notes | Parity Diffs | Result |
|---|---|---|---|---|---|---|---|
| `synthetic-crossing-wide-chord` | Generated | `loaded` | `loaded` | 14 | 14 | 0 | **PASS** |
| `synthetic-duplicate-identities` | Generated | `loaded` | `loaded` | 4 | 3 | 0 | **PASS** |
| `synthetic-invalid-empty` | Generated | `invalid` | `invalid` | 0 | 0 | 0 | **PASS** |
| `synthetic-invalid-non-midi` | Generated | `invalid` | `invalid` | 0 | 0 | 0 | **PASS** |
| `synthetic-invalid-truncated` | Generated | `repaired` | `repaired` | 0 | 0 | 0 | **PASS** |
| `synthetic-manual-fingering-gliss` | Generated | `loaded` | `loaded` | 8 | 8 | 0 | **PASS** |
| `synthetic-mismatched-track-labels` | Generated | `loaded` | `loaded` | 6 | 6 | 0 | **PASS** |
| `synthetic-scale-chords` | Generated | `loaded` | `loaded` | 19 | 19 | 0 | **PASS** |
| `synthetic-stress-512` | Generated | `loaded` | `loaded` | 512 | 512 | 0 | **PASS** |
| `synthetic-tempo-pedals-overlap` | Generated | `loaded` | `loaded` | 5 | 5 | 0 | **PASS** |
| `tracked-demo-song` | Tracked source | `loaded` | `loaded` | 193 | 193 | 0 | **PASS** |
| `tracked-right-hand` | Tracked source | `loaded` | `loaded` | 22 | 22 | 0 | **PASS** |
| `tracked-right-hand-octaves` | Tracked source | `loaded` | `loaded` | 44 | 44 | 0 | **PASS** |

**Summary**: 13/13 fixtures passed with **0 parity differences**. Status flags, source note inventories, identity mappings, normalized note documents, fingering assignments, performance press/release events, pedal controllers, and sampled poses matched the desktop reference output exactly within numerical tolerances.

---

## 3. Worker Lifecycle, Cancellation, and Rejection

### Cancellation Test
- **Action**: Started analysis on the 512-note stress fixture (`synthetic-stress-512`). While computation was underway, clicked the **Cancel** button (`#cancel-button`).
- **Observations**:
  - The Web Worker was terminated immediately via `worker.terminate()`.
  - The active request token and resource timeout were cleared.
  - UI status updated to `"Analysis canceled. The Worker was terminated."` with tone `"neutral"`.
  - `window.__m1LastResult` was cleared to `null`.
  - The Analyze button re-enabled promptly.
  - Subsequent execution of `tracked-right-hand` created a fresh Web Worker and completed successfully (22 notes loaded), confirming full recovery and clean state disposal.

### Invalid / Corrupt MIDI Rejection
- **Action 1 (Fixture dropdown)**: Selected `synthetic-invalid-non-midi` and clicked Analyze.
  - Worker returned typed `status: "invalid"` with `document: null`.
  - Diagnostic code `midi-load-failed` was generated with underlying `OSError` ("MThd not found").
  - UI status showed warning: `"MIDI input rejected after real Python execution (synthetic-invalid-non-midi.mid)."`.
- **Action 2 (File upload)**: Uploaded an arbitrary non-MIDI byte payload (`CORRUPT_NOT_A_MIDI_HEADER_1234567890`) via `#midi-file`.
  - Safely rejected with `status: "invalid"` and `midi-load-failed`.
  - Web Worker remained alive and functional.
- **Recovery verification**: Ran a subsequent valid analysis (`tracked-right-hand`) on the existing worker. Successfully completed without reload.

---

## 4. Performance Benchmarks and Resource Observations (W014)

### Execution Timing Benchmarks

Measured on the reference test system (Chromium headless shell via Playwright):

| Workload | Mode | Notes | Elapsed Duration | Analysis Stage Profile |
|---|---|---|---|---|
| `synthetic-crossing-wide-chord` | **Cold Start** | 14 | **4,262 ms** | Includes Worker boot, WASM compilation, package wheel loading (`numpy`, `pretty_midi`, `mido`, etc.), Python core VFS staging, and analysis |
| `synthetic-duplicate-identities` | Warm | 3 | **340 ms** | Pyodide cached in worker; pure Python import and planning |
| `synthetic-invalid-empty` | Warm | 0 | **102 ms** | Input validation, fast rejection |
| `synthetic-invalid-non-midi` | Warm | 0 | **65 ms** | Input validation, fast rejection |
| `synthetic-invalid-truncated` | Warm | 0 | **65 ms** | PrettyMIDI salvage / zero notes |
| `synthetic-manual-fingering-gliss` | Warm | 8 | **181 ms** | Fingering and glissando grouping |
| `synthetic-mismatched-track-labels` | Warm | 6 | **593 ms** | Cross-register hand heuristics |
| `synthetic-scale-chords` | Warm | 19 | **627 ms** | Scale and chord fingering optimization |
| `synthetic-stress-512` | Warm | 512 | **1,641 ms** | 512-note cost matrix and dynamic programming |
| `synthetic-tempo-pedals-overlap` | Warm | 5 | **541 ms** | Overlapping pedal event thresholding |
| `tracked-demo-song` | Warm | 193 | **1,227 ms** | Multi-track song analysis |
| `tracked-right-hand` | Warm | 22 | **420 ms** | Standard single-track test |
| `tracked-right-hand-octaves` | Warm | 44 | **517 ms** | Octave hand stretch calculation |

### Resource and Memory Observations
- **Cold Start Latency**: ~4.3 seconds to initialize Pyodide, catalog wheels, and custom core modules.
- **Warm Throughput**: Ranging from 65 ms (small/invalid) to 1,641 ms (512-note heavy computation).
- **Client Main Thread Memory**: `window.performance.memory.usedJSHeapSize` observed at ~22.03 MiB across test runs, remaining flat and without noticeable accumulation across serial fixture executions.
- **Worker Isolate**: Worker memory is isolated within Pyodide's WebAssembly linear memory pool (~35-50 MiB).

---

## 5. Defects Discovered and Resolved During Verification

During the browser verification process, the following defects were diagnosed and corrected:

1. **Protocol Message Discriminant Collision in Worker (`postProgress` / `postError`)**:
   - *Problem*: In `apps/client/src/workers/midi-analysis.worker.ts`, `postProgress` and `postError` constructed messages with `{ type: "progress", ...identity }` and `{ type: "worker-error", ...identity }`. Because the incoming `request` object was passed as `identity`, its `type: "analyze-midi"` property overwritten the message discriminant, causing Zod schema validation to fail with a `ZodError`.
   - *Fix*: Explicitly specified identity properties (`requestId`, `projectId`, `revision`, `engineVersion`) alongside the correct message discriminant.

2. **Missing `source_manifest.json` on Pyodide VFS**:
   - *Problem*: `handthesia_core/api.py` checks for `source_manifest.json` in its own package folder via `Path(__file__).with_name("source_manifest.json")`. The worker staged the Python files from `manifest.files`, but omitted `source_manifest.json` itself, causing `api.analyze_midi` to raise a `FileNotFoundError`.
   - *Fix*: Updated the worker runtime initialization to write `coreManifest` into `/python-core/handthesia_core/source_manifest.json` on the Pyodide filesystem before analysis runs.

3. **Undefined Optional Array Handling in Parity Engine**:
   - *Problem*: `compareM1ResultToGolden` accessed `golden.desktopNotes.length` in `expectedCounts`. For invalid-or-rejected fixtures (`synthetic-invalid-empty`, `synthetic-invalid-non-midi`), `desktopNotes` is not present in the golden file, which threw a `TypeError`.
   - *Fix*: Made `GoldenFixture` properties optional and used safe optional chaining (`golden.desktopNotes?.length ?? 0`).

4. **Window Diagnostic Exposure**:
   - *Improvement*: Added `(window as any).__m1LastResult = validated;` and `window.__m1LastError` in `apps/client/src/App.tsx`, providing deterministic testing inspectability without breaking application encapsulation.

---

## 6. Milestone Limitations and Non-Goals

- **Computation Only**: In accordance with Milestone M1 requirements, this workspace performs MIDI decoding, profile validation, fingering assignment, performance scheduling, and motion planning. It does not output sound (no Web Audio API) or render 3D/2D animation (no WebGL or Canvas rendering). Audio playback and animation remain scheduled for subsequent milestones (M2/M3).
