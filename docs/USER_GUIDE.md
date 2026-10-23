# PianoMotion Studio — User Guide

This guide covers navigating, editing, and using **PianoMotion Studio**.

---

## 1. Getting Started

1. Open PianoMotion Studio in a modern web browser (or install it via your browser's address bar as a Progressive Web App).
2. Choose **Open MIDI** in the empty workspace or **File → Import MIDI** and select a Standard MIDI file (`.mid`, `.midi`, up to 16 MiB). Drag-and-drop import is not currently supported. You can also open a built-in melody, a saved project package, or the demo song.
3. The studio validates the file, then analyzes it in a background Web Worker: tracks, tempo, pedals, hand split, and fingering.
4. The interactive 3D procedural hands and falling-notes scene mounts when analysis is ready.
5. If analysis fails, the current project is kept; use **Retry calculation** in Diagnostics or reopen the file.

---

## 2. Keyboard Shortcuts & Controls

Select **Fingering** in the top header to show hand/finger assignments, **Clear**, **Unplayable**, **Gliss**, and **Auto-advance**. On smaller windows these controls wrap into extra header rows. **Edit → Undo/Redo** retains keyboard shortcuts; **Help (?) → Keyboard shortcuts** opens the shortcut reference. Switching back to **Performance** hides assignments and keeps your selection and undo history.

**Auto-advance** is off by default. When enabled, assigning a finger selects the next note in chronological order (ascending pitch for simultaneous notes). Choosing a hand, clearing fingering or marking a note unplayable keeps your selection. Confirming the same finger can advance without creating another edit or history entry.

| Action | Shortcut | Mode / Scope |
|---|---|---|
| **Play / Pause** | `Spacebar` | Global |
| **Seek Backward / Forward** | `Left` / `Right` Arrow keys | Global |
| **Assign Finger 1–5** | Number keys `1`–`5` | Editor Mode |
| **Clear Fingering** | `0` | Editor Mode |
| **Mark Unplayable** | `Delete` / `Backspace` | Editor Mode |
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

Choose one of **five** procedural hand rendering styles in **Preferences → Appearance**:
- **Realistic**: Default shaded anatomical hands with photo-derived surface detail.
- **Cartoon**: Flesh-toned hand with fingernails, joints, forearm sleeves, and cuffs.
- **White Gloves**: Classic animation gloves with stitch accents on the back of the hand.
- **Robot Shell**: Futuristic metallic plates, joint cylinders, and dark fingertip pads.
- **Skeleton**: Anatomical bone segments and joints.

**Dynamic Shadows** is a separate appearance setting, not a sixth skin: it adds soft drop shadows whose offset and transparency scale with hand height ($Z$).

---

## 5. Audio & Video Export

### Video Export
1. Click **Export → Export video**.
2. Choose resolution: **1080p Full HD**, **720p HD**, **4K Ultra HD**, or **Current Window**.
3. Choose frame rate: **60 FPS** or **30 FPS**, and the container: **MP4** or **WebM**.
4. The dialog queries browser codec support for the selected size, frame rate, and audio setting. Start export only when the container is reported as supported.
5. Export uses the WebCodecs **`VideoEncoder`** (and `AudioEncoder` when audio is included) and Mediabunny muxing. It is unavailable in browsers without WebCodecs support; there is no MediaRecorder fallback.

### Audio in Video Export
Enable **Audio (Master)** in the video export dialog to include synthesized audio in the exported video. MP4 exports encode audio as AAC; WebM exports encode it as Opus, subject to browser codec support for the selected settings. The offline audio synthesizer normalizes peak volume to -1 dBFS (0.89 amplitude). A separate WAV download is not available.

---

## 6. Project Portability & Offline Persistence

- Projects and autosave snapshots are persisted in the browser's native **IndexedDB** (`handthesia_db` v2).
- To share or archive a song with all user fingering edits and custom profiles, click **Export Project Package** to download a `.pianomotion.json` package.
