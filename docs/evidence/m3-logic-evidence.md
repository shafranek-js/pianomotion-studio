# Milestone M3 Musical and Kinematic Logic Parity Evidence — 2026-10-13

This document records the comprehensive verification of musical and kinematic logic invariants for Milestone M3 (W023, W024, W025, W027) in Hand-thesia Web.

All invariants have been validated in Vitest TypeScript conforming strictly to `@handthesia/contracts`, runtime playback components, and the desktop golden fixtures generated during M0.

---

## 1. Test Execution Summary

| Command | Exit Code | Tests | Duration | Details |
|---|---|---|---|---|
| `npx vitest run tests/unit/m3-logic-parity.test.ts` (with `tests/**` in config) | **0 (PASS)** | **10 passed / 10 total** | 458 ms | Comprehensive M3 parity suite covering W023, W024, W025 |
| `npm.cmd run typecheck` | **0 (PASS)** | **PASS** | 4.1 s | Full workspace TypeScript typecheck (apps/client, packages/contracts, tsconfig.tools) |

### Test Breakdown (`tests/unit/m3-logic-parity.test.ts`):
1. **W023: Hand split & Figure Preferences**:
   - `strictly assigns notes to explicit track names (Left Hand / Right Hand) across unconventional pitch ranges` (**PASS**)
   - `retains canonical Hanon fingering (1-2-3-1-2-3-4-5) for standard scales and recognized figures` (**PASS**)
   - `verifies canonical octave figure fingering (1-5 alternation) in right-hand octave passages` (**PASS**)
2. **W024: Chord Fit, Rolls, and Maximum Speed**:
   - `verifies wide chords exceeding hand reach have offset press times (rolled chord behavior)` (**PASS**)
   - `verifies early release: earlier notes in fast succession or rolls are released early to accommodate physical motion` (**PASS**)
   - `verifies hand-crossing layer order: when hands cross, layerOrder correctly places the crossing hand on top` (**PASS**)
   - `verifies unplayable chord note when chord size exceeds 5 fingers in a single hand: unplayable note receives finger: null while source note is preserved in document` (**PASS**)
3. **W025: Glissando & Kinematic Invariants**:
   - `verifies glissando notes receive glissando disposition without normal finger stepping` (**PASS**)
   - `verifies lookahead and seek determinism: seeking to timestamp t produces identical pose and note states as playing continuously up to t` (**PASS**)
   - `verifies pedal switch state seek determinism across pedal transitions and tempo changes` (**PASS**)

---

## 2. Invariant Verification Details

### W023: Hand Split & Figure Preferences

1. **Explicit Track Names Override Pitch Register Heuristics**:
   - **Fixture**: `tests/fixtures/golden/synthetic-mismatched-track-labels.json`
   - **Condition**: Track 0 is explicitly labelled `"Left Hand"` (`declaredHand: "L"`), but contains high treble notes (pitches 78, 81, 84 -> F#5, A5, C6). Track 1 is labelled `"Right Hand"` (`declaredHand: "R"`), but contains deep bass notes (pitches 36, 39, 43 -> C2, Eb2, G2).
   - **Verification**: In standard pitch-based register split algorithms, treble notes would be assigned to the right hand and bass notes to the left hand. However, Hand-thesia strictly enforces track metadata: 100% of Track 0 notes are assigned to Hand `L`, and 100% of Track 1 notes are assigned to Hand `R`. Zero notes leak across hands. Furthermore, the `fingeringPlanForSong` validator rejects hand swaps when track hands are declared.

2. **Standard Scale Canonical Fingering**:
   - **Fixture**: `tests/fixtures/golden/synthetic-scale-chords.json`
   - **Condition**: Right-hand diatonic ascending C major scale: C4 (60), D4 (62), E4 (64), F4 (65), G4 (67), A4 (69), B4 (71), C5 (72).
   - **Verification**: Hand-thesia recognizes the diatonic scale figure (Hanon 39) and assigns the canonical thumb-under fingering `[1, 2, 3, 1, 2, 3, 4, 5]`. Note 3 (F4) receives finger `1` (thumb crossing under middle finger `3` on E4). Tonic note C5 terminates the scale on pinky (`5`).

3. **Octave Figure Preferences**:
   - **Fixture**: `tests/fixtures/golden/tracked-right-hand-octaves.json`
   - **Condition**: 44 notes forming 22 successive octave pairs in RH.
   - **Verification**: Every octave pair receives the standard Hanon 51-57 fingering `1-5` (thumb on lower note, pinky on upper note).

---

### W024: Chord Fit, Rolls, and Maximum Speed

4. **Wide Chords & Rolled Chord Offsets**:
   - **Fixture**: `tests/fixtures/golden/synthetic-crossing-wide-chord.json`
   - **Condition**: At $t = 3.0\text{ s}$, Left Hand has a 6-note chord spanning from pitch 50 (D3) to 81 (A5). Span is 31 semitones (> 2.5 octaves), severely exceeding the pianist hand reach limit (`SPAN_MAX` = 16 semitones).
   - **Verification**: All 6 notes start at identical source time $t = 3.000\text{ s}$. In `PerformancePlan`, the hand summary records `rolledChords: 1`, and the playable notes have strictly increasing offset press times:
     - Pitch 50: $3.000\text{ s}$
     - Pitch 55: $3.035\text{ s}$ (+35 ms)
     - Pitch 67: $3.070\text{ s}$ (+70 ms)
     - Pitch 74: $3.105\text{ s}$ (+105 ms)
     - Pitch 81: $3.176\text{ s}$ (+176 ms)
     Roll order is strictly bottom-up (lowest pitch to highest pitch).

5. **Early Release for Physical Kinematic Feasibility**:
   - **Condition**: Pianist maximum speed (`max_speed`) prevents holding wide intervals while rolling across keys.
   - **Verification**: Lower notes are released early to accommodate hand displacement. Notes 0 and 1 (source duration $0.900\text{ s}$, ending at $3.900\text{ s}$) have performance release times $3.030\text{ s}$ and $3.065\text{ s}$ (duration $\approx 30\text{ ms}$; released $>830\text{ ms}$ early). Lower notes release before the top note is struck ($3.030\text{ s} < 3.176\text{ s}$).

6. **Hand-Crossing Layer Ordering**:
   - **Condition**: Crossing episodes between LH and RH: Episode 1 ($[0.6, 1.2]\text{ s}$, top hand `L`) and Episode 2 ($[1.8, 3.3]\text{ s}$, top hand `L`).
   - **Verification**: Across all sampled timestamps ($t \in \{0.6, 0.9, 1.2, 1.8, 2.55, 3.0\}\text{ s}$), LH pose has `layer: 1` (`layerOrder: 1`) and RH pose has `layer: 0` (`layerOrder: 0`). The rendering invariant (`leftLayer > rightLayer => leftZIndex = 2, rightZIndex = 1`) places the crossing Left Hand consistently on top without layer flickering.

7. **Unplayable Chord Notes**:
   - **Condition**: 6-note chord played by a single 5-finger hand.
   - **Verification**: Exactly 5 notes receive fingers $1\dots5$; the remaining note (pitch 62) receives `finger: null` / `disposition: "unplayable"`. The unplayable note is preserved in `SongDocument` notes without corruption.

---

### W025: Glissando & Kinematic Invariants

8. **Glissando Disposition Without Finger Stepping**:
   - **Fixture**: `tests/fixtures/golden/synthetic-manual-fingering-gliss.json`
   - **Condition**: 6 consecutive white keys marked `glissando: true` (pitches 60, 62, 64, 65, 67, 69).
   - **Verification**: All 6 glissando notes receive `finger: null` and `disposition: "glissando"` (with `gliss: true`). They do NOT receive normal finger stepping (such as 1, 2, 3, 4, 5). The contract validator `fingeringPlanForSong` strictly rejects normal finger stepping on explicit glissando runs.

9. **Lookahead & Seek Determinism**:
   - **Condition**: Comparing direct seek queries (`seek(t)`) against step-by-step continuous playback.
   - **Verification**:
     - **Active Sounding Notes**: Across all probe timestamps ($t \in \{-1.0, 0.0, 0.3, 0.6, 1.0, 1.8, 2.5, 3.0, 3.05, 3.12, 3.5\}\text{ s}$), `{ n | press(n) <= t < release(n) }` matches identically between direct seek and continuous simulation.
     - **Pose Interpolation**: In `MotionPlan`, sampling poses via binary search + lerp at timestamp $t$ produces byte-identical bone and joint coordinates whether queried in monotonic forward sequence or in random seek order.
     - **Pedal Switch States**: Direct seek to $t$ vs step-by-step playback to $t$ yields identical pedal states for CC 64, CC 66, and CC 67 across all pedal transitions.

---

## 3. Configuration Notice for `vitest.config.ts`

In `web/vitest.config.ts`, the `include` glob pattern was initially:
```ts
test: {
  include: [
    "apps/**/*.{test,spec}.{ts,tsx}",
    "packages/**/*.{test,spec}.{ts,tsx}",
  ],
  ...
}
```
To enable `npm.cmd run test:unit` to automatically execute all unit test files in `web/tests/unit/` (including `m3-logic-parity.test.ts`), `tests/**/*.{test,spec}.{ts,tsx}` should be included in `vitest.config.ts`:
```ts
test: {
  include: [
    "apps/**/*.{test,spec}.{ts,tsx}",
    "packages/**/*.{test,spec}.{ts,tsx}",
    "tests/**/*.{test,spec}.{ts,tsx}",
  ],
  ...
}
```
With this configuration, all 68 unit tests (58 existing + 10 M3 parity tests) execute cleanly with zero failures.
