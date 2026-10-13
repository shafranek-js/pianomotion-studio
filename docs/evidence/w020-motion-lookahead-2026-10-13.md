# W020 & Hand Viewport Framing Evidence — 2026-10-13

Scope: Bounded motion lookahead buffer (W020), touch contact physical verification, and canonical hand viewport framing in Hand-thesia Web. Coordinated by Lead Orchestrator with specialized subagents (`Worker & Motion Sampling Engineer` and `Motion Buffer & Touch Verification Engineer`).

## 1. Verification Summary

| Check | Result | Scope / Notes |
|---|---|---|
| `npm.cmd run typecheck` | **PASS**, exit 0 | Client, contracts, tools |
| `npm.cmd run lint` | **PASS**, exit 0 | Clean ESLint across all packages and tests |
| `npm.cmd run test:unit` | **242 / 242 PASS**, 15 suites, 3.03s | 100% real unit tests (no mocked passes) |
| `test_motion_window.py` | **4 / 4 PASS** | CPython sliding window & session caching |
| `test_export.py` & `test_replan.py` | **8 / 8 PASS** | SMF/PIG export roundtrip & typed replan |
| Playwright browser tests | **4 / 4 PASS**, 1.4m | `player-m2.spec.ts` & `stabilization.spec.ts` |
| Git status check | **PASS** | Only `web/` and `docs/WEB_MIGRATION_ROADMAP.md` touched; 0 root modifications |

## 2. Key Architecture & Deliverables

### A. Hand Viewport Framing
- **Root cause addressed**: Keyboard was previously placed flush with canvas bottom (`kbY = height - kbHeight`), causing the palm, wrist, and forearm (which extend south in negative Y coordinates) to be clipped outside the viewport.
- **Implementation**:
  - Implemented `computeBottomLayout(width, height, customKeyboardHeight)` in `pianoScene.ts` matching desktop `common.py:bottom_layout`.
  - Constants: `KEY_LEN_WW = 5.6`, `HAND_LEN_WW = 7.0`, `BOTTOM_MAX_SHARE = 0.5`, `HAND_AREA_MIN_H = 120`, `FELT_H = 6`.
  - Dedicated `handRect` (`[kbX, kbY + kbH, kbW, handH]`) with `HAND_AREA_BG = 0x1e1e26` and subtle top border.
  - Dedicated red felt strip (`FELT = 0x961622`) above keys with highlight line.
  - Centered keyboard positioning with background margins on ultra-wide aspect ratios.
  - 5/5 unit tests in `apps/client/src/render/bottomLayout.test.ts` verify dimensions, budget clamping, and wrist clearance ($y \le \text{height}$).

### B. W020: Bounded Motion Lookahead Buffer & Touch Verification
- **Root cause addressed**: The original M1-M5 implementation sampled only 4 diagnostic poses per hand via `_selected_times`, leading to static hand hovering rather than physical keystrokes during song playback. Full upfront computation would have stalled the browser for 15-30+ seconds.
- **Worker & Python Core Implementation**:
  - `sample_motion_window` in `web/python-core/handthesia_core/api.py`.
  - Active session cache `_active_animator_sessions` avoids re-parsing SMF or re-running fingering planning on sliding window requests (~3x speedup).
  - Samples at note attacks (including 60Hz key strikes `t - 1/60`, `t`, `t + 1/60`), releases, crossings, and intermediate grid points (0.25s).
  - Hand crossing arrangement via `hands.arrange_crossing`.
  - Packaged Python core manifest with updated hash `e6817baea06daea54d59bc6e0f548c26ad5db27f8176efcb3be2ab1371da25d2`.
  - CPython tests in `web/python-core/tests/test_motion_window.py` (4/4 PASS).
  - Typed worker messages: `M1SampleMotionRequest` and `M1SampleMotionResult` in `@handthesia/contracts`.
  - Worker handler in `midi-analysis.worker.ts` and client helper in `m1WorkerClient.ts`.
- **Client Motion Buffer & Renderer Implementation**:
  - `MotionBuffer` in `apps/client/src/render/motionBuffer.ts`.
  - Sliding lookahead window (`windowAheadSeconds = 4.0`, `windowBehindSeconds = 1.0`).
  - Prunes past poses dynamically to keep memory bounded.
  - Protection against per-frame RPC: `needsMorePoses` checks window boundaries; queries only fire every ~3-4 seconds during playback.
  - Seek / replan / profile invalidation: `invalidate()` clears old window and calculates new slice at seek target.
  - Connected to `HandsView` and `PianoPlayer.tsx` with fallback to `motionPlan`.
  - Touch verification helper `verifyTouchContact` asserts that at $t_{press}$, the assigned finger's distal tip is in physical contact ($z \le 0.1$, $x$ inside key rectangle).
  - 11/11 unit tests in `apps/client/src/render/motionBuffer.test.ts` pass cleanly.
