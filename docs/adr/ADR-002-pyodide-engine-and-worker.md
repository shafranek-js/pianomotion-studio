# ADR-002: Pyodide Web Worker Architecture for Computational Core

Date: 2026-10-13  
Status: Accepted (Gate G1 Decision)

## Context

Hand-thesia requires complex computational processing for incoming MIDI files:
1. Multi-track parsing and pitch/track/register hand splitting (`hand_split.py`).
2. Pattern recognition for piano idioms (`figures.py`) and glissando detection (`glissando.py`).
3. Combinatorial beam search for ergonomic fingering planning (`fingering.py`).
4. Procedural inverse kinematics (IK), chord roll scheduling, and hand-crossing layering (`hands.py`).

Rewriting the entire mathematical core in TypeScript would introduce significant regression risk and duplicate ongoing algorithmic development. The alternate proposal evaluated in Milestone M1 was executing the decoupled Python core (`handthesia_core`) in a client-side WebAssembly runtime using Pyodide in a dedicated module Web Worker.

## Decision

We accept **Pyodide 314.0.7 in a dedicated module Web Worker** as the primary execution engine for all batch computational tasks (MIDI analysis, hand splitting, fingering planning, performance generation, and motion planning).

### Key Architectural Commitments:
1. **Self-Hosted Pinned Runtime & Assets**:
   - Pyodide runtime (314.0.7, Python 3.14.2, ABI `2026_0`, platform `emscripten_5_0_3`) and catalog packages (`numpy` 2.4.6, `packaging` 26.1, `six` 1.17.0, `micropip` 0.11.1) are vendored locally in `apps/client/public/pyodide/`.
   - Pure-Python wheels (`pretty-midi` 0.2.11.post0, `mido` 1.3.3) are staged and verified by SHA-256 digests.
   - Analysis execution does not perform dynamic CDN resolution or external PyPI network requests.

2. **Dedicated Worker Isolation**:
   - Worker runs in its own thread and V8/WASM memory isolate. The UI main thread remains completely unblocked during long analyses.
   - Jobs are serialized (one active compute job per worker instance).
   - Cancellation is handled via immediate `worker.terminate()` and clean resource disposal. A new worker is created on-demand for subsequent requests.

3. **Measured Parity & Performance**:
   - 13/13 test fixtures achieved 0 parity differences compared to the desktop Python reference across status, source notes, normalized notes, fingering assignments, performance events, pedals, and sampled bone/joint poses.
   - The original M1 run measured cold initialization at ~4.2–4.4 seconds and cached runs at ~60 ms for simple/invalid inputs, ~400–600 ms for typical pieces and ~1.6 s for 512 notes. These are historical observations, not service guarantees.
   - A fresh worker is created for each application job; cached asset downloads do not eliminate Python/WASM initialization. The stabilization corpus measured 4506 ms initially and 2029 ms for the cached 512-note fixture.
   - Main-page JS heap observations do not cover Worker/WASM memory or prove absence of leaks. Full memory and weak-device acceptance remains open.

4. **Fallback & Boundary**:
   - Continuous frame-by-frame rendering and real-time audio playback will **not** invoke per-frame Pyodide RPCs. `PerformancePlan` feeds Web Audio and actual performed note visuals. The current `MotionPlan` contains sparse diagnostic poses; continuous motion/lookahead (W020) still needs implementation and physical/visual acceptance.

## Stabilization acceptance boundary

The [2026-10-13 stabilization evidence](../evidence/stabilization-2026-10-13.md) records typed direct replanning, stable note IDs/manual intents, coherent live plans and session recovery through the real compiled Worker. The architecture choice remains accepted for local desktop browsers. Sampled numeric parity does not establish correct fingertip contact at every event, long-run memory behavior, weak-device performance or complete M6 integration. No server migration is required by the currently measured results.

## Consequences

- Gate G1 is formally **PASSED**.
- Milestone M2 (PixiJS 88-key piano roll & falling notes, skeleton hands rendering, and Web Audio API playback) may proceed based on precomputed `PerformancePlan` and `MotionPlan` DTOs.
- FastAPI remains a documented server-side fallback option for resource-constrained or weak mobile devices if needed in later milestones, but is not required for desktop browser operation.
