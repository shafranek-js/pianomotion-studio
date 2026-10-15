# PianoMotion Studio — Release Notes

**Version**: 0.1.0-dev.4

**Date**: 2026-10-15

**Status**: Development preview. Manual hardware/listening and load limits remain open. Previous dev.3 was published to GitHub Pages; current UI verification is recorded separately below.
**Architecture**: Offline-First Progressive Web Application (SPA + Web Workers + WebAssembly)

---

## Editor command menus and Auto-advance — dev.4

The secondary toolbar above the scene is removed. Undo/Redo move into the Edit menu while retaining keyboard shortcuts. Help (?) opens a menu with Keyboard shortcuts. Auto-advance replaces Step Entry and sits with finger assignments in the header, visible only in Fingering and off by default. Only numeric finger assignments advance selection; hand assignment, Clear, Unplayable and Gliss retain selection. Confirming an already assigned finger can advance without adding an edit or history entry.

The same editor session owns menu actions and keyboard shortcuts. The portable project format remains v2. Validation: 401 unit tests, typecheck, lint and project-path production build passed. Edge passed all 13 changed UI scenarios; Chrome passed 11 initially, followed by all 3 focused scenarios after responsive-header and Escape fixes. Ten viewport sizes/boundaries and keyboard access to the scrolled mobile scene were checked. Exact runs, screenshots and limits are in [dev.4 evidence](evidence/editor-command-menus-2026-10-15/VERIFICATION.md).

The deliberately invalid, text-like MIDI fixture is now marked binary in Git attributes so Windows autocrlf cannot change its byte-exact checksum. A fresh autocrlf checkout preserves the expected hash. The previous Windows CI run stopped at that checksum before browser tests; its result is not a browser pass.

## Historical UI change: fingering header controls — dev.3

Hand, finger, Clear, Unplayable and Gliss assignments move next to the workspace mode switch in the top header, visible only in Fingering. Smaller windows wrap these controls into additional header rows. Undo/Redo, Step Entry and Shortcuts stay above the shared scene. The editor session and canvas stay mounted when switching modes. The package format remains v2.

Focused verification: 25 unit tests; Chrome 11 scenarios plus final editor/responsive reruns; Edge 11 scenarios; typecheck, scoped lint and build passed. Six standard viewports and four additional header boundary widths have no page horizontal overflow or inaccessible header controls. See [UI evidence](evidence/fingering-header-2026-10-15/VERIFICATION.md) for exact runs and screenshots. This is separate from the preceding audit checks below.

## Current remediation

The active record is [AUDIT_REPAIR_PROGRESS.md](AUDIT_REPAIR_PROGRESS.md). This preview adds committed-save/update barriers, content-addressed offline releases with old-tab pins, bounded motion streaming, one performance-event audio path, local Signalsmith 1.3.2 time stretch, prepared SF2/MIDI outputs and deterministic MP4/WebM export. The application version is synchronized across workspaces and the status bar.

Automatic verification: **397 unit tests, 28 Python tests, all 13 frozen fixtures**, typecheck/lint/build, and Windows Chrome/Edge UI, Worker, audio, production PWA and native media decode scenarios. Exact outcomes and the Chrome PWA full-plus-focused correction are recorded in the active matrix. Production builds always pin production mode even when invoked from a Vite development process. Real decoded examples and JSON evidence are retained with the report.

Manual gates remain for a user's compatible SF2 bank, physical MIDI, subjective listening and complete motion review. Worker analysis finished the 2k-note benchmark; 10k and a valid 50k MIDI timed out at 120 seconds and are not accepted as supported loads. See [ROLLBACK.md](ROLLBACK.md) for non-destructive recovery, [audio support](AUDIO_SUPPORT.md) for the explicit SF2 subset and cancellation boundary, and [dependency notices](evidence/licenses-2026-10-15.md) for corrected Signalsmith MIT and Mediabunny MPL-2.0 evidence. Source redistribution rights remain unresolved.

**Everything below is historical milestone documentation.** Its old test totals, renderer descriptions, MediaRecorder fallback and two-cache model do not describe current acceptance or the current export/PWA implementation. Do not cite the historical test table as a current pass.

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
