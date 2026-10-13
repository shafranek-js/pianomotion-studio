# PianoMotion Studio — Release Notes

**Version**: 1.0.0-web  
**Release Date**: 2026-10-13  
**Status**: Production Ready / Release Gate G8 Closed  
**Architecture**: Offline-First Progressive Web Application (SPA + Web Workers + WebAssembly)

---

## 1. Executive Summary

PianoMotion Studio is a complete, browser-native piano animation, fingering analysis, and performance visualization system. All compute-intensive operations—including MIDI parsing, ergonomic cost-optimization fingering planning, kinematic collision resolution, and frame-accurate pose interpolation—run locally on client hardware via Pyodide WebAssembly in background Web Workers.

---

## 2. Key Capabilities & Milestone Breakdown

### Milestone M1: WebAssembly Core & Zero-Deviation Baseline
- **Headless Worker Architecture**: Pyodide 314.0.7 running in a dedicated `Worker` isolated from the main UI thread.
- **Strict Typed Contracts**: Complete bidirectional TypeScript/Python DTO schemas powered by `@handthesia/contracts` and Zod (`SongDocument`, `FingeringPlan`, `PerformancePlan`, `MotionPlan`).
- **Golden Corpus Parity**: 13 out of 13 reference fixtures validated with zero unassigned notes and sub-millisecond execution timing parity.

### Milestone M2: High-Performance Playback & Scene Rendering
- **PixiJS 8 Rendering Pipeline**: Accelerated 2D rendering of realistic and equal 88-key piano keyboards (A0 to C8), color-coded falling notes (LH blue, RH green), and skeletal hands.
- **Web Audio Transport & Sampler**: Lookahead-scheduled polyphonic audio synthesizer featuring harmonic overtone modeling and full MIDI pedal handling (Sustain CC 64, Sostenuto CC 66, Soft Pedal CC 67).
- **Transport Synchronization**: Master AudioContext clock driving playhead position, speed scaling (0.25x to 2.0x), and lead-in count-in periods.

### Milestone M3: Musical Logic, Kinematics & MIDI Export
- **Canonic Figure Modeling**: Canonical scale fingering (e.g., 1-2-3-1-2-3-4-5 in C major RH) and explicit track assignment overrides.
- **Biomechanical Constraints**: Automatic rolled chords for spans exceeding physical hand stretch, early releases for consecutive fast strikes, and dynamic layer-ordering during hand crossings.
- **Glissando & Export Invariants**: 100% round-trip retention of assigned hand and finger meta-events in exported standard MIDI files (`.mid`) and PIG format notation.

### Milestone M4: Interactive Piano Roll Editor & Diagnostics
- **Canvas 2D Piano Roll**: Viewport-culled, 60 FPS horizontal piano roll with smooth zoom (40–600 px/sec) and pan controls.
- **Fingering Manipulation**: Single and marquee note selection, step-entry sequential assignment, and 50-step undo/redo history.
- **Ergonomics & Difficulty Engine**: Real-time evaluation of stretch semitones, note velocity density, awkward transitions, and difficulty classification (Beginner to Virtuoso).

### Milestone M5: Profiles, Customization & Native Storage
- **Anatomy & Behavior Profiles**: Full support for custom pianist profiles (Small Hands, Virtuoso, Left-Hand Dominant) with bone length adjustments and kinematic weight sliders.
- **Pianist Profile Importer**: Seamless import and validation of custom pianist profile `.json` configuration files.
- **IndexedDB `handthesia_db` v2**: Persistent client-side database with transactional schema upgrades, autosave session recovery snapshots, and storage quota protection.

### Milestone M6: Visual Skins, Audio Sync & Waveform Scrubbing
- **Procedural Hand Skins**: Realistic Cartoon Flesh, White Cartoon Gloves, Futuristic Robot Shell, and Classic Skeleton styles with soft drop shadows and depth ordering.
- **External Audio Synchronization**: In-browser decoding of WAV, MP3, OGG, and FLAC recordings with 5ms peak extraction.
- **Waveform Timeline**: Synchronized waveform alignment canvas with coarse drag and 10ms Shift-fine offset scrubbing.

### Milestone M7: Offline / Real-Time Video & Master Audio Export
- **Headless Video Export Engine**: Offscreen PixiJS canvas rendering with MediaRecorder capture (VP9/VP8 WebM / MP4) at 1080p, 720p, 4K, and Window resolutions.
- **Master Audio Offline Synthesizer**: Pure 16-bit PCM RIFF WAV encoder with peak normalization targeting -1 dBFS (0.89 max amplitude, up to 16.0x gain).
- **Export UI & Cancellation**: Live export modal with progress bars, status updates, cancellation cleanup, and direct video/WAV downloads.

### Milestone M8: Progressive Web App, Hosting & Hardened Security
- **PWA Standalone Mode**: Web App Manifest (`manifest.webmanifest`) and responsive vector/PNG application icons.
- **Dual-Cache Service Worker (`sw.js`)**: Offline application shell caching (`handthesia-shell-v1`) and immutable Pyodide runtime caching (`handthesia-pyodide-v1`).
- **Security Hardening**:
  - Content Security Policy (CSP) permitting local WASM compilation without remote eval.
  - Strict upload payload limits: 16 MiB MIDI, 32 MiB project packages, 100 MiB audio recordings.
  - Path traversal and filename sanitization defending against directory traversal, control characters, and reserved Windows device names (`CON`, `PRN`, `AUX`, etc.).
  - Prototype pollution defenses rejecting malicious `__proto__`, `constructor`, and `prototype` object properties.

---

## 3. Verified Test Matrix

| Test Suite | Total Tests | Passed | Execution Time |
|---|---|---|---|
| Vitest Unit Tests (18 suites) | 295 | 295 (100%) | 3.31 s |
| Playwright E2E Browser Tests (10 suites) | 27 | 27 (100%) | ~2.5 min |
| Python Core Parity Tests (3 suites) | 12 | 12 (100%) | 2.1 s |
| TypeScript Typecheck | All workspaces | Clean (0 errors) | 3.4 s |
| ESLint Scoped Check | All workspaces | Clean (0 errors) | 2.8 s |
| Production Build | Full client bundle | Built in 409 ms | 409 ms |

---

## 4. Known Boundaries & Non-Goals

1. **Local-Only Storage**: Projects and profiles reside in browser IndexedDB. Cloud synchronization requires Milestone M9 (separate enterprise backend).
2. **MediaRecorder Codec Availability**: WebM (VP9/VP8) is universally supported on Chromium and Firefox; Safari may default to MP4/H.264 based on OS codecs.
3. **Hardware Acceleration**: 60 FPS playback is optimized for hardware-accelerated WebGL 2.0; software fallbacks may throttle falling notes rendering during intense polyphonic passages.
