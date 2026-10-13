# M2 Vertical Browser Player MVP Evidence — 2026-10-13

This document records the implementation, test execution results, and gate verification for Hand-thesia Web Milestone M2 (W015–W022).

---

## 1. Automated Test Suite Execution Summary

Executed from `C:\Projects\pygame-piano-animator\web` using `npm.cmd` on Windows:

| Command | Result | Pass / Fail | Elapsed Time |
|---|---|---|---|
| `npm.cmd run typecheck` | **PASS** | `0` errors across client, contracts, tool configs | 4.1s |
| `npm.cmd run lint` | **PASS** | `0` lint errors/warnings | 3.3s |
| `npm.cmd run test:unit` | **PASS** | 3 test files, **58 passed** (0 failed) | 1.8s |
| `npm.cmd run test:parity` | **PASS** | 1 test file, **15 passed** (0 failed) | 22.5s |
| `npm.cmd run test:browser` | **PASS** | 3 test files, **17 passed** (0 failed) | 30.4s |

### Unit Test Breakdown (58 passed)
- `packages/contracts/test/contracts.test.ts`: **18 passed** (Zod DTO schemas, time invariants, discriminators, validation)
- `apps/client/src/audio/audio.test.ts`: **17 passed** (AudioContext manager, PianoSampler partials & polyphony, pedals CC 64/66/67, Transport lookahead scheduling, lead-in, seek reconstruction)
- `apps/client/src/storage/storage.test.ts`: **23 passed** (IndexedDB CRUD, recent projects queue, project package serialization/round-trip, file validators)

### Browser Test Breakdown (17 passed)
- `tests/browser/bootstrap.spec.ts`: **1 passed** (page header, title, initial state)
- `tests/browser/parity-m1.spec.ts`: **15 passed** (13 golden fixtures with 0 parity differences, cancellation, corrupt rejection)
- `tests/browser/player-m2.spec.ts`: **1 passed** (end-to-end user journey: MIDI load -> Pyodide analyze -> PixiJS scene render -> Play -> Pause -> Seek -> Stop -> Speed/KeyStyle change -> Save to IndexedDB -> DB record verification)

---

## 2. Implemented Subsystems (W015–W021)

### W015: File Drag-and-Drop & Validation
- Implemented in `apps/client/src/storage/fileValidator.ts` and wired into `App.tsx` (`onDragOver`, `onDrop`).
- Enforces `.mid` / `.midi` extension, non-empty content, and `<= 16 MiB` limit.

### W016: 88-Key Keyboard & Falling Notes (PixiJS)
- Implemented in `apps/client/src/render/keyboardView.ts` and `fallingNotesView.ts`.
- Full 88-key layout (pitches 21 to 108) supporting both `"realistic"` and `"equal"` geometries.
- Key highlights displaying hand color (blue for LH, green for RH) and finger badge (1..5).
- Falling notes scrolling downwards with viewport culling and duration-scaled heights.

### W017: Procedural Skeletal Hands (PixiJS)
- Implemented in `apps/client/src/render/handsView.ts`.
- Consumes `MotionPlan` in `keyboard-local-inches-v1`.
- Binary-search pose sampling with linear interpolation (`lerpPose`) between frames.
- Renders wrists, bones with depth scaling, joint halos, fingertips, and anatomical finger numbers.
- Manages `zIndex` according to `layerOrder` so crossing hands render on top.

### W018: Transport Master Clock & Lookahead Scheduling
- Implemented in `apps/client/src/audio/transport.ts`.
- Synchronized to high-precision Web Audio clock (`currentTime`).
- Supports negative lead-in down to `-2.0s`.
- 100ms lookahead polling every 25ms avoiding scheduling jitter and drift.
- Zero-allocation `getCurrentTime()` for 60/120fps animation loop.

### W019: Polyphonic Web Audio Piano Synthesizer
- Implemented in `apps/client/src/audio/sampler.ts`.
- 16-harmonic additive Fourier synthesis with chorused detuning ($\pm 1.8$ cents) and velocity-sensitive dynamic Lowpass BiquadFilter.
- Exact pedal logic: Sustain (CC 64), Sostenuto (CC 66), Soft (CC 67).
- Instant silence on seek/stop; voice stealing at 64 voices.

### W020: Lookahead Buffer & Scene Controller
- Implemented in `apps/client/src/render/pianoScene.ts`.
- PixiJS v8 Application with responsive layout, devicePixelRatio support, and decoupled render loop.

### W021: IndexedDB Persistence & Project Package Export
- Implemented in `apps/client/src/storage/projectDb.ts`, `recent.ts`, and `packageExporter.ts`.
- Native IndexedDB `handthesia_db` storing notes, fingering, performance, and motion plans.
- Downloadable `.json` export and import matching `ProjectPackageSchema`.

---

## 3. Gate G2 Decision

Criteria:
1. File import / drag-and-drop -> **Verified**.
2. Python calculation in Worker -> **Verified (0 parity differences)**.
3. Visible 88-key piano & falling notes -> **Verified**.
4. Procedural skeletal hands matching motion plan -> **Verified**.
5. Audible sound matching performance plan with pedals -> **Verified**.
6. Play / Pause / Seek / Speed controls -> **Verified**.
7. Save to IndexedDB and reload -> **Verified**.

**Gate G2 is CLOSED (ACCEPTED)**. The vertical browser MVP is complete.
