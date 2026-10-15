# PianoMotion Studio — User Guide

This guide covers navigating, editing, and using **PianoMotion Studio**.

---

## 1. Getting Started

1. Open PianoMotion Studio in a modern web browser (or install it via your browser's address bar as a Progressive Web App).
2. Drag and drop any Standard MIDI file (`.mid`, `.midi` up to 16 MiB) into the workspace, or choose an example track from the dropdown list.
3. Click **Analyze MIDI** to initiate the background Pyodide WebAssembly worker.
4. The worker automatically extracts tracks, normalizes tempo and pedals, splits notes between hands, and computes optimal fingering.
5. The interactive 3D procedural hands and falling notes scene will mount immediately.

---

## 2. Keyboard Shortcuts & Controls

Select **Fingering** in the top header to show hand and finger assignments, **Clear**, **Unplayable**, and **Gliss** next to the mode switch. On smaller windows these controls wrap into extra header rows. **Undo/Redo**, **Step Entry**, and **Shortcuts** remain above the scene. Switching back to **Performance** hides editing controls and keeps your selection and undo history.

| Action | Shortcut | Mode / Scope |
|---|---|---|
| **Play / Pause** | `Spacebar` | Global |
| **Seek Backward / Forward** | `Left` / `Right` Arrow keys | Global |
| **Assign Finger 1–5** | Number keys `1`–`5` | Editor Mode |
| **Clear Fingering** | `0` or `Delete` | Editor Mode |
| **Assign Left Hand** | `L` | Editor Mode |
| **Assign Right Hand** | `R` | Editor Mode |
| **Toggle Glissando** | `G` | Editor Mode |
| **Undo / Redo** | `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) | Editor Mode |
| **Zoom Piano Roll** | `Ctrl + Mouse Wheel` (40 to 600 px/sec) | Editor Mode |
| **Pan Piano Roll** | `Middle Drag`, `Space + Drag`, or `Shift + Wheel` | Editor Mode |
| **Audio Sync Fine Scrub** | `Shift + Mouse Drag` on Waveform (10ms steps) | Audio Sync Header |

---

## 3. Pianist Profiles

PianoMotion Studio supports fully custom biomechanical profiles:

1. Open the **Profiles** modal.
2. Select between built-in presets:
   - **Default**: Standard adult hand reach.
   - **Small Hands**: Scaled for youth or smaller spans with reduced stretch penalty.
   - **Virtuoso**: Extended spans, higher speed tolerance, aggressive rolled chord handling.
   - **Left-Hand Lead**: Prioritizes left hand dominance.
3. Customize bone lengths: Adjust individual metacarpals (`mc1..5`), proximal (`pp1..5`), middle (`mp2..5`), and distal (`dp1..5`) phalanxes.
4. Adjust behavioral weights: Tendon link strength, crossing lift height, wrist bounce, tremolo rotation, and black key avoidance.
5. **Import / Export**: Import any existing profile `.json` file or export your customized profile.

---

## 4. Visual Styles (Hand Skins)

Choose between 4 procedural hand rendering styles in the settings panel:
- **Cartoon**: Flesh-toned hand with fingernails, joints, forearm sleeves, and cuffs.
- **White Gloves**: Classic animation gloves with stitch accents on the back of the hand.
- **Robot Shell**: Futuristic metallic plates, joint cylinders, and dark fingertip pads.
- **Skeleton**: Anatomical bone segments and joints.
- **Dynamic Shadows**: Soft drop shadows whose offset and transparency scale with hand height ($Z$).

---

## 5. Audio & Video Export

### Video Export
1. Click **Export Video** in the toolbar.
2. Choose resolution: **1080p Full HD**, **720p HD**, **4K Ultra HD**, or **Current Window**.
3. Choose frame rate: **60 FPS** (fluid, high quality) or **30 FPS** (faster export).
4. Click **Start Export**: A headless offscreen PixiJS canvas renders every frame with MediaRecorder streaming to `.webm`.

### Master Audio Export
1. Enable audio rendering during video export or export master audio separately.
2. The offline audio synthesizer normalizes peak volume to -1 dBFS (0.89 amplitude) and encodes high-fidelity 16-bit PCM RIFF WAV audio.

---

## 6. Project Portability & Offline Persistence

- Projects and autosave snapshots are persisted in the browser's native **IndexedDB** (`handthesia_db` v2).
- To share or archive a song with all user fingering edits and custom profiles, click **Export Project Package** to download a `.pianomotion.json` package.
