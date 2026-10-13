# Milestone M7: Offline / Real-Time Video Export & Gate G7 Verification — 2026-10-13

Scope: Milestone M7 (W045–W049) covering headless export scene rendering, resolution presets (1080p, 720p, 4K, window), MediaRecorder WebCodecs frame capture, offline master audio rendering (slicing recordings and polyphonic note synthesis with peak normalization), RIFF PCM WAV encoding, export progress weighting (0.86 / 0.10 / 0.04), cancellation, and Gate G7 closure.

## 1. Verification Summary

| Check | Result | Scope / Notes |
|---|---|---|
| `npm.cmd run typecheck` | **PASS**, exit 0 | Client, contracts, tools |
| `npm.cmd run lint` | **PASS**, exit 0 | 0 warnings, 0 errors |
| `npm.cmd run test:unit` | **255 / 255 PASS**, 17 suites, 3.17s | 100% real unit tests (13 export tests) |
| CPython tests | **12 / 12 PASS** | `test_motion_window.py` (4/4), `test_export.py` (4/4), `test_replan.py` (4/4) |
| `video-export-m7.spec.ts` | **1 / 1 PASS**, 23.1s | E2E modal opening, presets, cancellation, full render, video & WAV download |
| Regression browser tests | **9 / 9 PASS**, 2.4m | `bootstrap.spec.ts`, `editor-m4.spec.ts`, `player-m2.spec.ts`, `profiles-m5.spec.ts`, `skins-audio-m6.spec.ts`, `stabilization.spec.ts` (3/3), `video-export-m7.spec.ts` |
| `npm.cmd run build` | **PASS**, exit 0 | Production build generated in 1.41s |
| Dev server HTTP check | **HTTP 200** | Running on `http://127.0.0.1:5175/` |
| Git status integrity | **PASS** | Strict adherence to write boundaries; zero modifications to root desktop code |

---

## 2. Milestone Deliverables (W045–W049)

### A. W045: Export Scene, Resolution Presets, Timing & Headless Canvas
- **Resolution Presets (`videoDimensions.ts`)**:
  - `1080p`: 1920×1080 Full HD
  - `720p`: 1280×720 HD
  - `4k`: 3840×2160 Ultra HD
  - `window`: Current browser viewport clamped to even dimensions.
  - `ensureEvenDimension`: Enforces even integer widths and heights (`w - w % 2`, `h - h % 2`) as required by standard video encoders (H.264 / VP9 4:2:0 chroma).
- **Video Timing Calculation (`calculateExportTiming`)**:
  - Matches desktop `video_export.py`:
    - `t0 = leadInSeconds` (e.g. -2.0s)
    - `durationSeconds = (songDuration - t0) / speed + tailSeconds` (`VIDEO_TAIL_S = 1.5s`)
    - `totalFrames = Math.max(1, Math.round(durationSeconds * fps))`

### B. W046: MediaRecorder & Headless Scene Capture Loop
- **Video Exporter Engine (`videoExporter.ts`)**:
  - Initializes headless offscreen canvas and dedicated PixiJS `PianoScene`.
  - Suppresses all editor/transport overlays; captures only piano roll, keyboard, felt, and skeletal hands.
  - Streams frames via `canvas.captureStream(options.fps)` to `MediaRecorder` with progressive VP9/VP8/H.264 MIME type negotiation.
  - Deterministic frame stepping: updates scene timestamp $t = t_0 + (i / \text{fps}) \times \text{speed}$, renders PixiJS stage, and feeds recorder chunks.
  - Progress weighting matching desktop:
    - Frames rendering: 0.00 .. 0.86 (`WEIGHT_FRAMES = 0.86`)
    - Audio rendering: 0.86 .. 0.96 (`WEIGHT_AUDIO = 0.10`)
    - Multiplexing / assembly: 0.96 .. 1.00 (`WEIGHT_MUX = 0.04`)

### C. W047: Offline Audio Rendering, WAV Encoder & Peak Normalization
- **WAV Encoder (`wavEncoder.ts`)**:
  - Generates standard 44-byte RIFF PCM WAV headers.
  - Interleaves and clamps float32 audio samples to 16-bit signed PCM integers (-32768 to 32767).
  - Emits downloadable `audio/wav` Blobs.
- **Offline Audio Renderer (`offlineAudioRenderer.ts`)**:
  - Synced recordings: Slices audio samples directly from buffer starting at `audioOffset + startTime / speed` for `durationSeconds`, padding with silence where out-of-bounds.
  - Synth voices: Polyphonic harmonic synthesis matching acoustic piano partials and velocity-scaled exponential gain envelopes.
  - Peak normalization matching desktop: Target peak `NORMALIZE_PEAK = 0.89` (-1 dBFS) with gain scaling capped at `NORMALIZE_GAIN_MAX = 16.0x`.

### D. W048: Progress, Cancellation & Live Preview UI
- **Modal Dialog (`VideoExportModal.tsx`)**:
  - Header with title and close button.
  - Resolution selector, frame rate selector (60 / 30 FPS), master audio toggle, and audio source selector.
  - Target dimensions badge, speed indicator, and tail padding badge.
  - Progress bar (`<progress id="export-progress-bar">`), status text (`#export-status-text`), and ETA countdown (`#export-eta-text`).
  - Live thumbnail preview canvas (`#export-preview-canvas`) mirroring offscreen frames during recording.
  - Action buttons:
    - Idle: `🎥 Start Export` (`#start-export-btn`), Cancel.
    - Running: `✕ Cancel Export` (`#cancel-export-btn`) which aborts the controller and cleans up headless resources.
    - Completed: `⬇ Download Video` (`#download-video-btn`), `⬇ Download WAV` (`#download-audio-btn`), Close.
- **Integration (`PianoPlayer.tsx`)**:
  - "🎥 Export Video (.webm)" button added to persistence bar (`#player-export-video-button`).
  - Safe memoized `exportDataSource` prevents unnecessary re-renders.

### E. Gate G7 Verification
- Playwright E2E spec: `tests/browser/video-export-m7.spec.ts`.
- Verifies:
  - Opening modal from persistence bar.
  - Changing resolution and FPS presets.
  - Starting export and immediately cancelling; asserting clean abort and button reset.
  - Running full export to completion at 30 FPS.
  - Verifying progress updates, live canvas preview, and completion status.
  - Verifying presence of video and master audio WAV download buttons.
  - Closing modal cleanly.
  - Zero console errors or unhandled exceptions.

---

## 3. Gate G7 Status: CLOSED (PASSED)

Milestone M7 is complete and verified. Hand-thesia Web is ready to progress to Milestone M8 (Deployment, PWA & Final Polish: W050–W055).
