# Milestone M6: Visual Hand Skins, Audio Synchronization & Gate G6 Verification — 2026-10-13

Scope: Milestone M6 (W039–W044) covering procedural hand skins (`cartoon`, `gloves`, `robot`, `skeleton`), drop shadows, external audio recording decoding & playback synchronization, interactive waveform canvas, SoundFont/Web MIDI output selector, and Gate G6 closure.

## 1. Verification Summary

| Check | Result | Scope / Notes |
|---|---|---|
| `npm.cmd run typecheck` | **PASS**, exit 0 | Client, contracts, tools |
| `npm.cmd run lint` | **PASS**, exit 0 | 0 warnings, 0 errors |
| `npm.cmd run test:unit` | **242 / 242 PASS**, 15 suites, 3.17s | 100% real unit tests (no mocked passes) |
| CPython tests | **12 / 12 PASS** | `test_motion_window.py` (4/4), `test_export.py` (4/4), `test_replan.py` (4/4) |
| `skins-audio-m6.spec.ts` | **1 / 1 PASS**, 14.9s | E2E skin switching, shadow toggle, audio upload, waveform canvas |
| Regression browser tests | **8 / 8 PASS** | `player-m2.spec.ts`, `profiles-m5.spec.ts`, `stabilization.spec.ts` (3/3), `bootstrap.spec.ts`, `editor-m4.spec.ts` |
| `npm.cmd run build` | **PASS**, exit 0 | Production build generated in 456ms |
| Dev server HTTP check | **HTTP 200** | Running on `http://127.0.0.1:5175/` |
| Git status integrity | **PASS** | Strict adherence to write boundaries; zero modifications to root desktop code |

---

## 2. Milestone Deliverables (W039–W044)

### A. W039: Procedural Hand Skin Styles & Projected Drop Shadows
- **Skin Styles (`apps/client/src/render/skins/`)**:
  - `cartoonSkin.ts`: Flesh tone hands with forearm sleeve capsule, cuff accent band, knuckle creases, and distal fingernails.
  - `glovesSkin.ts`: Animated white cartoon gloves with dark sleeve, puffy rounded wrist cuff, bold dark outline, and 3 radiating back-of-hand stitch lines.
  - `robotSkin.ts`: Futuristic metallic cylinders at joints, segmented shell plates with gaps, fingertip caps, and seamed palm plates.
  - `skeletonSkin.ts`: Bare bones and joints with minimalist dark bone aesthetics.
- **Shadow Renderer (`shadowRenderer.ts`)**:
  - Directional projected drop shadows under hands.
  - Projection offset scaled by hand elevation `zIn` (`dx = 0.15 * zIn * ppi`, `dy = 0.25 * zIn * ppi`).
  - Depth-attenuated alpha scaling (0.35 down to 0.1) as hands lift above the key plane.
- **Integration**:
  - `HandsView` and `PianoScene` dynamically switch skin style and toggle drop shadow in response to `SettingsModal` changes.
  - 24/24 unit tests in `apps/client/src/render/skins.test.ts`.

### B. W040 & W041: Audio Recording Decoding, Waveform & Playback Synchronization
- **Audio Decoder (`audioDecoder.ts`)**:
  - Decodes `.wav`, `.mp3`, `.ogg`, `.flac` into Web Audio `AudioBuffer`.
  - Computes 5ms peak amplitude array matching desktop `audio_sync.py` (`PEAK_T = 0.005s`).
  - Memory-bounded viewport peak extraction (`extractViewportPeaks`) enabling 60 FPS zoom and scroll rendering.
- **Synced Audio Source (`syncedAudioSource.ts`)**:
  - Web Audio clock-anchored playback source.
  - Formula matching desktop: `audioTime = recordingOffsetSeconds + (songTime / speed)`.
  - Integrated with `Transport`: forwards play, pause, seek, speed changes, and volume adjustments.
- **Waveform Canvas Component (`WaveformCanvas.tsx`)**:
  - Interactive HTML5 canvas rendering the audio waveform aligned with song timeline.
  - Waveform color `#6096d2` matching desktop `WAVE_COLOR = (96, 150, 210)`.
  - Drag to adjust offset (100ms coarse steps; Shift-held 10ms fine steps).
- **Player UI Integration (`PianoPlayer.tsx`)**:
  - "🎵 Sync Audio" button with hidden file input for audio files.
  - "✕ Audio" removal button.
  - Waveform canvas mounted above the piano scene when audio recording is active.
- **Unit Tests**:
  - 29/29 unit tests in `apps/client/src/audio/recording.test.ts`.

### C. W042 & W043: Sound Output Architecture (SoundFont & Web MIDI)
- Sound output engine selector in `SettingsModal.tsx` (`synth`, `soundfont`, `webmidi`).
- Reactive badges in `PianoPlayer.tsx` reflecting active audio output engine.
- Unit tests in `soundfont.test.ts` (3/3) and `webMidi.test.ts` (4/4).

### D. W044 & Gate G6 Verification
- Dedicated Playwright browser integration spec `tests/browser/skins-audio-m6.spec.ts`.
- Verifies:
  - Switching skin style to `gloves`, `robot`, and `skeleton`.
  - Toggling hand drop shadow checkbox.
  - Switching audio engine output.
  - Uploading in-memory synthetic 440 Hz PCM WAV file.
  - Waveform canvas rendering and timeline alignment.
  - Clearing audio track.
  - Zero unhandled console or page errors throughout the user journey.

---

## 3. Gate G6 Status: CLOSED (PASSED)

Milestone M6 is complete and verified. Hand-thesia Web is ready to progress to Milestone M7 (Video Export: W045–W049).
