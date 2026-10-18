import type { Note } from "@handthesia/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clusterNotesIntoSteps,
  PlayAlongEngine,
} from "./playAlongEngine";

function createMockNote(id: string, pitch: number, start: number, end: number, hand: "left" | "right", finger = 1): Note {
  return {
    noteId: id,
    trackId: "track-0",
    pitch,
    velocity: 80,
    startSeconds: start,
    endSeconds: end,
    hand,
    finger,
    glissando: false,
  };
}

afterEach(() => vi.useRealTimers());

describe("PlayAlongEngine", () => {
  it("clusters simultaneous and near-simultaneous notes into steps", () => {
    const notes: Note[] = [
      // Chord 1 at t = 1.0s (C4, E4, G4)
      createMockNote("n1", 60, 1.0, 2.0, "right", 1),
      createMockNote("n2", 64, 1.02, 2.0, "right", 3),
      createMockNote("n3", 67, 1.03, 2.0, "right", 5),
      // Left hand base at t = 1.01s (C3)
      createMockNote("n4", 48, 1.01, 2.5, "left", 5),
      // Note 2 at t = 2.5s (D4)
      createMockNote("n5", 62, 2.5, 3.0, "right", 2),
    ];

    const steps = clusterNotesIntoSteps(notes, null, "both");
    expect(steps).toHaveLength(2);

    // Step 0
    expect(steps[0]!.index).toBe(0);
    expect(steps[0]!.timeSeconds).toBe(1.0);
    expect(steps[0]!.notes).toHaveLength(4);
    expect(steps[0]!.targetPitches).toEqual(new Set([48, 60, 64, 67]));
    expect(steps[0]!.activePitches).toEqual(new Set([48, 60, 64, 67]));

    // Step 1
    expect(steps[1]!.index).toBe(1);
    expect(steps[1]!.timeSeconds).toBe(2.5);
    expect(steps[1]!.notes).toHaveLength(1);
    expect(steps[1]!.targetPitches).toEqual(new Set([62]));
  });

  it("filters driving notes by practice mode and prevents empty steps", () => {
    const notes: Note[] = [
      createMockNote("n1", 60, 1.0, 2.0, "right", 1),
      createMockNote("n2", 48, 1.0, 2.0, "left", 5),
      createMockNote("n3", 52, 1.5, 2.5, "left", 3),
      createMockNote("n4", 64, 2.0, 3.0, "right", 3),
    ];

    const rightSteps = clusterNotesIntoSteps(notes, null, "right");
    expect(rightSteps).toHaveLength(2);
    expect(rightSteps[0]!.activePitches).toEqual(new Set([60]));
    expect(rightSteps[1]!.activePitches).toEqual(new Set([64]));

    const leftSteps = clusterNotesIntoSteps(notes, null, "left");
    expect(leftSteps).toHaveLength(2);
    expect(leftSteps[0]!.activePitches).toEqual(new Set([48]));
    expect(leftSteps[1]!.activePitches).toEqual(new Set([52]));
  });

  it("advances to next step upon releasing held chord keys", () => {
    const notes: Note[] = [
      createMockNote("n1", 60, 1.0, 2.0, "right", 1),
      createMockNote("n2", 64, 1.0, 2.0, "right", 3),
      createMockNote("n3", 67, 2.0, 3.0, "right", 5),
    ];

    const onPlayNote = vi.fn();
    const onStopNote = vi.fn();
    const onChordHit = vi.fn();
    const onTimeChange = vi.fn();

    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 0, // instant for unit test
      onPlayNote,
      onStopNote,
      onChordHit,
      onTimeChange,
    });

    engine.start();
    expect(engine.getState()).toBe("waiting");
    expect(engine.getCurrentStepIndex()).toBe(0);
    expect(onTimeChange).toHaveBeenCalledWith(1.0);

    // Press first note of chord
    engine.noteOn(60, 90);
    expect(onPlayNote).toHaveBeenCalledWith(60, 90, "playalong-60");
    expect(engine.getState()).toBe("waiting"); // still waiting for 64

    // Press second note of chord -> chord fulfilled!
    engine.noteOn(64, 90);
    expect(onChordHit).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toBe("held");

    // Release only one note -> still held
    engine.noteOff(60);
    expect(onStopNote).toHaveBeenCalledWith(60, "playalong-60");
    expect(engine.getState()).toBe("held");

    // Release last note -> keys released! Advances to next step!
    engine.noteOff(64);
    expect(onStopNote).toHaveBeenCalledWith(64, "playalong-64");
    expect(engine.getCurrentStepIndex()).toBe(1);
    expect(engine.getState()).toBe("waiting");
    expect(onTimeChange).toHaveBeenCalledWith(2.0);
  });

  it("tolerates sustained notes without wrong-note penalty", () => {
    // Left hand plays an arpeggio while right hand holds a sustained chord
    const notes: Note[] = [
      createMockNote("lh1", 48, 0.0, 0.5, "left", 5),
      createMockNote("rh1", 64, 0.0, 2.0, "right", 1), // sustained across steps
      createMockNote("lh2", 52, 0.5, 1.0, "left", 3),
      createMockNote("lh3", 55, 1.0, 1.5, "left", 1),
    ];

    const onWrongNote = vi.fn();
    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 0,
      onWrongNote,
    });

    engine.start();
    // Step 0: play 48 and 64
    engine.noteOn(48);
    engine.noteOn(64);
    expect(engine.getState()).toBe("held");

    // Release only 48 (which ends at 0.5s), while keeping 64 held
    engine.noteOff(48);
    // Should advance to Step 1 because 48 has ended and next step is at 0.5s!
    expect(engine.getCurrentStepIndex()).toBe(1);
    expect(engine.getState()).toBe("waiting");

    // At Step 1, user continues holding or re-strikes 64
    engine.noteOn(64);
    expect(onWrongNote).not.toHaveBeenCalled();

    // Now user hits the active note of Step 1: 52
    engine.noteOn(52);
    expect(engine.getState()).toBe("held");
  });

  it("supports legato advancement when next step note is pressed while current step is held", () => {
    const notes: Note[] = [
      createMockNote("n1", 60, 1.0, 2.0, "right", 1),
      createMockNote("n2", 62, 2.0, 3.0, "right", 2),
    ];

    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 0,
    });

    engine.start();
    engine.noteOn(60);
    expect(engine.getState()).toBe("held");

    // While still holding 60, user presses note 62 of next step
    engine.noteOn(62);
    // Automatically advances and fulfills step 1!
    expect(engine.getCurrentStepIndex()).toBe(1);
    expect(engine.getState()).toBe("held");
  });

  it("instantly completes transition and captures note if pressed during transition", () => {
    const notes: Note[] = [
      createMockNote("n1", 60, 0.0, 1.0, "right", 1),
      createMockNote("n2", 64, 1.0, 2.0, "right", 3),
    ];

    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 300,
    });

    engine.start();
    engine.noteOn(60);
    engine.noteOff(60);
    // State is transitioning to step 1
    expect(engine.getState()).toBe("transitioning");
    expect(engine.getCurrentStepIndex()).toBe(1);

    // User hits key 64 during transition!
    engine.noteOn(64);
    // Should instantly complete transition and register key 64!
    expect(engine.getState()).toBe("held");
    expect(engine.getCompletedPitchesInStep().has(64)).toBe(true);
  });

  it("checks already held keys when advancing to a new step", () => {
    const notes: Note[] = [
      createMockNote("n1", 60, 0.0, 1.0, "right", 1),
      createMockNote("n2", 64, 1.0, 2.0, "right", 3),
    ];

    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 0,
    });

    engine.start();
    // User plays note 60 for step 0 AND prepares/presses note 64
    engine.noteOn(60);
    engine.noteOn(64); // 64 is held
    expect(engine.getState()).toBe("held");

    // Release 60 -> advances to step 1
    engine.noteOff(60);
    expect(engine.getCurrentStepIndex()).toBe(1);
    // Step 1 expects 64, which is ALREADY held by user!
    expect(engine.getState()).toBe("held");
    expect(engine.getCompletedPitchesInStep().has(64)).toBe(true);
  });

  it("notifies on wrong note but maintains waiting state", () => {
    const notes: Note[] = [createMockNote("n1", 60, 1.0, 2.0, "right", 1)];
    const onWrongNote = vi.fn();

    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 0,
      onWrongNote,
    });

    engine.start();
    engine.noteOn(61, 80); // C#4 pressed instead of C4
    expect(onWrongNote).toHaveBeenCalledWith(61);
    expect(engine.getState()).toBe("waiting");

    // Now press correct note
    engine.noteOn(60, 80);
    expect(engine.getState()).toBe("held");
  });

  it("reaches completed state when the last step is finished", () => {
    const notes: Note[] = [createMockNote("n1", 60, 1.0, 2.0, "right", 1)];

    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 0,
    });

    engine.start();
    engine.noteOn(60, 80);
    expect(engine.getState()).toBe("held");
    engine.noteOff(60);
    expect(engine.getState()).toBe("completed");
  });

  it("supports manual step navigation", () => {
    const notes: Note[] = [
      createMockNote("n1", 60, 1.0, 2.0, "right", 1),
      createMockNote("n2", 62, 2.0, 3.0, "right", 2),
      createMockNote("n3", 64, 3.0, 4.0, "right", 3),
    ];

    const engine = new PlayAlongEngine({ notes, transitionDurationMs: 0 });
    engine.start();
    expect(engine.getCurrentStepIndex()).toBe(0);

    engine.nextStep();
    expect(engine.getCurrentStepIndex()).toBe(1);

    engine.nextStep();
    expect(engine.getCurrentStepIndex()).toBe(2);

    engine.previousStep();
    expect(engine.getCurrentStepIndex()).toBe(1);

    engine.restart();
    expect(engine.getCurrentStepIndex()).toBe(0);
  });

  it("plays through real piece steps smoothly (Anthem of Ukraine pattern)", () => {
    // Anthem opening pattern:
    // Step 0: LH 48 (C3, 0.0-0.35s), RH 64 (E4, 0.0-1.07s)
    // Step 1: LH 52 (E3, 0.375-0.73s)
    // Step 2: LH 55 (G3, 0.75-1.46s)
    // Step 3: RH 64 (E4, 1.125-1.48s)
    // Step 4: RH 64 (E4, 1.500-1.87s)
    // Step 5: RH 62 (D4, 1.875-2.25s)
    const anthemNotes: Note[] = [
      createMockNote("lh1", 48, 0.0, 0.35, "left", 3),
      createMockNote("rh1", 64, 0.0, 1.07, "right", 3),
      createMockNote("lh2", 52, 0.375, 0.73, "left", 2),
      createMockNote("lh3", 55, 0.75, 1.46, "left", 1),
      createMockNote("rh2", 64, 1.125, 1.48, "right", 3),
      createMockNote("rh3", 64, 1.500, 1.87, "right", 3),
      createMockNote("rh4", 62, 1.875, 2.25, "right", 2),
    ];

    // 1. Right hand mode has NO empty steps
    const rightEngine = new PlayAlongEngine({
      notes: anthemNotes,
      handMode: "right",
      transitionDurationMs: 0,
    });
    rightEngine.start();
    expect(rightEngine.getSteps().length).toBeGreaterThan(0);
    for (const step of rightEngine.getSteps()) {
      expect(step.activePitches.size).toBeGreaterThan(0);
    }

    // Step 0 in right hand is 64
    expect(rightEngine.getCurrentStep()?.activePitches).toEqual(new Set([64]));
    rightEngine.noteOn(64);
    expect(rightEngine.getState()).toBe("held");
    rightEngine.noteOff(64);
    // Advances to Step 1 without getting stuck!
    expect(rightEngine.getCurrentStepIndex()).toBe(1);
    expect(rightEngine.getCurrentStep()?.activePitches).toEqual(new Set([64]));

    // 2. Both hands mode
    const bothEngine = new PlayAlongEngine({
      notes: anthemNotes,
      handMode: "both",
      transitionDurationMs: 0,
    });
    bothEngine.start();
    // Step 0: 48 (LH) and 64 (RH)
    bothEngine.noteOn(48);
    bothEngine.noteOn(64);
    expect(bothEngine.getState()).toBe("held");

    // Pianist releases only 48 (LH), keeps holding 64 (RH)
    bothEngine.noteOff(48);
    // Advances to Step 1 because 48 has ended
    expect(bothEngine.getCurrentStepIndex()).toBe(1);
    expect(bothEngine.getState()).toBe("waiting");

    // Pianist plays 52 (LH) while holding 64 (RH)
    bothEngine.noteOn(52);
    expect(bothEngine.getState()).toBe("held");

    // Pianist releases 52 (LH)
    bothEngine.noteOff(52);
    expect(bothEngine.getCurrentStepIndex()).toBe(2);
    expect(bothEngine.getState()).toBe("waiting");

    // Pianist plays 55 (LH)
    bothEngine.noteOn(55);
    expect(bothEngine.getState()).toBe("held");
  });

  it("handles complex multi-note chords and advances upon key release", () => {
    // 4-note chord at t=0s, followed by single note at t=1.0s
    const notes: Note[] = [
      createMockNote("lh1", 55, 0.0, 1.2, "left", 5),
      createMockNote("lh2", 59, 0.0, 1.2, "left", 3),
      createMockNote("lh3", 62, 0.0, 1.2, "left", 1),
      createMockNote("rh1", 74, 0.0, 0.3, "right", 5),
      createMockNote("rh2", 67, 1.0, 1.5, "right", 1),
    ];

    const onChordHit = vi.fn();
    const onTimeChange = vi.fn();
    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 0,
      onChordHit,
      onTimeChange,
    });

    engine.start();
    expect(engine.getState()).toBe("waiting");
    expect(engine.getCurrentStepIndex()).toBe(0);

    // Strike 3 of the 4 notes
    engine.noteOn(55);
    engine.noteOn(59);
    engine.noteOn(62);
    expect(engine.getState()).toBe("waiting");
    expect(onChordHit).not.toHaveBeenCalled();

    // Strike 4th note -> chord satisfied!
    engine.noteOn(74);
    expect(onChordHit).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toBe("held");

    // Release 3 notes, but 1 is still held
    engine.noteOff(55);
    engine.noteOff(59);
    engine.noteOff(62);
    expect(engine.getState()).toBe("held");
    expect(engine.getCurrentStepIndex()).toBe(0);

    // Release final held note of the chord -> advances immediately!
    engine.noteOff(74);
    expect(engine.getCurrentStepIndex()).toBe(1);
    expect(engine.getState()).toBe("waiting");
    expect(onTimeChange).toHaveBeenCalledWith(1.0);
  });

  it("instantly advances on staccato / quick strike chord where keys are released upon completion", () => {
    const notes: Note[] = [
      createMockNote("n1", 60, 0.0, 0.5, "right", 1),
      createMockNote("n2", 64, 0.0, 0.5, "right", 3),
      createMockNote("n3", 67, 1.0, 1.5, "right", 5),
    ];

    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 0,
    });

    engine.start();
    // User taps 60 quickly (down then up)
    engine.noteOn(60);
    engine.noteOff(60);
    expect(engine.getState()).toBe("waiting");

    // User taps 64 quickly: noteOn fulfills chord, but 60 is already released and 64 is released
    engine.noteOn(64);
    // Since 60 was released and 64 is the last key, releasing 64 advances:
    engine.noteOff(64);
    expect(engine.getCurrentStepIndex()).toBe(1);
    expect(engine.getState()).toBe("waiting");
  });

  it("aligns step timestamps with performancePlan press/release events when provided", () => {
    const notes: Note[] = [
      createMockNote("n1", 60, 0.0, 0.5, "right", 1),
      createMockNote("n2", 64, 0.5, 1.0, "right", 3),
    ];

    const performancePlan = {
      projectId: "proj-1",
      inputRevision: 1,
      profileId: "prof-1",
      tempoMap: [{ timeSeconds: 0, bpm: 120 }],
      events: [
        { eventId: "e1", noteId: "n1", hand: "right" as const, finger: 1 as const, pitch: 60, velocity: 80, type: "press" as const, timeSeconds: 0.12 },
        { eventId: "e2", noteId: "n1", hand: "right" as const, finger: 1 as const, pitch: 60, velocity: 80, type: "release" as const, timeSeconds: 0.58 },
        { eventId: "e3", noteId: "n2", hand: "right" as const, finger: 3 as const, pitch: 64, velocity: 80, type: "press" as const, timeSeconds: 0.62 },
        { eventId: "e4", noteId: "n2", hand: "right" as const, finger: 3 as const, pitch: 64, velocity: 80, type: "release" as const, timeSeconds: 1.1 },
      ],
    };

    const engine = new PlayAlongEngine({
      notes,
      performancePlan,
      transitionDurationMs: 0,
    });

    const steps = engine.getSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0]!.timeSeconds).toBeCloseTo(0.12, 5);
    expect(steps[1]!.timeSeconds).toBeCloseTo(0.62, 5);
  });

  it("preserves nearest step timestamp when switching handMode", () => {
    const notes: Note[] = [
      createMockNote("lh1", 48, 0.0, 0.5, "left", 5),
      createMockNote("rh1", 60, 0.0, 0.5, "right", 1),
      createMockNote("lh2", 50, 1.0, 1.5, "left", 4),
      createMockNote("rh2", 62, 2.0, 2.5, "right", 2),
      createMockNote("lh3", 52, 2.0, 2.5, "left", 3),
    ];

    const engine = new PlayAlongEngine({
      notes,
      handMode: "both",
      transitionDurationMs: 0,
    });

    engine.start();
    engine.seekToStep(2); // t = 2.0s
    expect(engine.getCurrentStep()?.timeSeconds).toBe(2.0);

    engine.setHandMode("right");
    // In right hand mode, steps are at 0.0s (rh1) and 2.0s (rh2) -> should land on step index 1 (t = 2.0s)
    expect(engine.getCurrentStep()?.timeSeconds).toBe(2.0);
    expect(engine.getCurrentStepIndex()).toBe(1);
  });

  it("does not double-play audio or skip steps when playing legato and releasing previous note late", () => {
    const notes: Note[] = [
      createMockNote("n1", 60, 0.0, 1.0, "right", 1),
      createMockNote("n2", 62, 1.0, 2.0, "right", 2),
      createMockNote("n3", 64, 2.0, 3.0, "right", 3),
    ];

    const onPlayNote = vi.fn();
    const onChordHit = vi.fn();

    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 0,
      onPlayNote,
      onChordHit,
    });

    engine.start();
    engine.noteOn(60, 85);
    expect(onPlayNote).toHaveBeenCalledTimes(1);
    expect(onChordHit).toHaveBeenCalledTimes(1);
    expect(engine.getCurrentStepIndex()).toBe(0);

    // Legato: press 62 before releasing 60
    engine.noteOn(62, 90);
    expect(onPlayNote).toHaveBeenCalledTimes(2);
    expect(onChordHit).toHaveBeenCalledTimes(2);
    expect(engine.getCurrentStepIndex()).toBe(1);
    expect(engine.getState()).toBe("held");

    // Now release old note 60 -> must NOT skip step 1!
    engine.noteOff(60);
    expect(engine.getCurrentStepIndex()).toBe(1);
    expect(engine.getState()).toBe("held");

    // Finally release 62 -> advances to step 2!
    engine.noteOff(62);
    expect(engine.getCurrentStepIndex()).toBe(2);
    expect(engine.getState()).toBe("waiting");
  });

  it("schedules companion notes by their onset offset from the current step", async () => {
    vi.useFakeTimers();
    const notes: Note[] = [
      createMockNote("r1", 60, 0, 0.9, "right"),
      createMockNote("r2", 62, 1, 1.5, "right"),
      createMockNote("l1", 48, 0, 0.2, "left"),
      createMockNote("l2", 50, 0.5, 0.8, "left"),
    ];
    const onPlayNote = vi.fn();
    const engine = new PlayAlongEngine({
      notes,
      handMode: "right",
      transitionDurationMs: 0,
      onPlayNote,
    });

    engine.start();
    engine.noteOn(60);
    expect(onPlayNote).toHaveBeenNthCalledWith(1, 60, 80, "playalong-60");
    expect(onPlayNote).toHaveBeenNthCalledWith(2, 48, 75, "playalong-companion-1");

    await vi.advanceTimersByTimeAsync(499);
    expect(onPlayNote.mock.calls.map(([pitch]) => pitch)).not.toContain(50);

    await vi.advanceTimersByTimeAsync(1);
    expect(onPlayNote).toHaveBeenCalledWith(50, 75, "playalong-companion-2");
  });

  it.each(["stop", "seek", "hand mode", "auto-play disabled", "dispose"] as const)(
    "cancels pending and active companion voices on %s",
    async (action) => {
      vi.useFakeTimers();
      const notes: Note[] = [
        createMockNote("r1", 60, 0, 0.9, "right"),
        createMockNote("r2", 62, 1, 1.5, "right"),
        createMockNote("l1", 48, 0, 1, "left"),
        createMockNote("l2", 50, 0.5, 0.8, "left"),
      ];
      const onPlayNote = vi.fn();
      const onStopNote = vi.fn();
      const engine = new PlayAlongEngine({
        notes,
        handMode: "right",
        transitionDurationMs: 0,
        onPlayNote,
        onStopNote,
      });

      engine.start();
      engine.noteOn(60);
      expect(onPlayNote).toHaveBeenCalledWith(48, 75, "playalong-companion-1");
      expect(onStopNote).not.toHaveBeenCalledWith(48, "playalong-companion-1");

      if (action === "stop") engine.stop();
      else if (action === "seek") engine.seekToStep(1);
      else if (action === "hand mode") engine.setHandMode("left");
      else if (action === "auto-play disabled") engine.setAutoPlayOtherHand(false);
      else engine.dispose();

      expect(onStopNote).toHaveBeenCalledWith(48, "playalong-companion-1");
      await vi.advanceTimersByTimeAsync(1000);
      expect(onPlayNote.mock.calls.filter(([, , voiceId]) => String(voiceId).startsWith("playalong-companion-")))
        .toHaveLength(1);
      expect(onStopNote.mock.calls.filter(([, voiceId]) => String(voiceId).startsWith("playalong-companion-")))
        .toEqual([[48, "playalong-companion-1"]]);
    },
  );

  it("uses separate occurrence IDs for repeated companion pitches and releases each owner exactly once", async () => {
    vi.useFakeTimers();
    const notes: Note[] = [
      createMockNote("r1", 60, 0, 0.25, "right"),
      createMockNote("r2", 62, 0.5, 1, "right"),
      createMockNote("l1", 48, 0, 0.25, "left"),
      createMockNote("l2", 48, 0.5, 2.5, "left"),
    ];
    const onPlayNote = vi.fn();
    const onStopNote = vi.fn();
    const engine = new PlayAlongEngine({
      notes,
      handMode: "right",
      transitionDurationMs: 0,
      onPlayNote,
      onStopNote,
    });

    engine.start();
    engine.noteOn(60);
    engine.noteOff(60);
    engine.noteOn(62);

    expect(onPlayNote).toHaveBeenCalledWith(48, 75, "playalong-companion-1");
    expect(onPlayNote).toHaveBeenCalledWith(48, 75, "playalong-companion-2");
    expect(onStopNote).toHaveBeenCalledWith(48, "playalong-companion-1");

    await vi.advanceTimersByTimeAsync(250);
    expect(onStopNote.mock.calls.filter(([, voiceId]) => String(voiceId).startsWith("playalong-companion-")))
      .toEqual([[48, "playalong-companion-1"]]);

    await vi.advanceTimersByTimeAsync(1749);
    expect(onStopNote).not.toHaveBeenCalledWith(48, "playalong-companion-2");
    await vi.advanceTimersByTimeAsync(1);
    expect(onStopNote.mock.calls.filter(([, voiceId]) => String(voiceId).startsWith("playalong-companion-")))
      .toEqual([
        [48, "playalong-companion-1"],
        [48, "playalong-companion-2"],
      ]);
  });

  it.each(["stop", "dispose"] as const)("stops held user voices on %s", (action) => {
    const onStopNote = vi.fn();
    const engine = new PlayAlongEngine({
      notes: [createMockNote("r1", 60, 0, 1, "right")],
      transitionDurationMs: 0,
      onStopNote,
    });

    engine.start();
    engine.noteOn(60);
    if (action === "stop") engine.stop();
    else engine.dispose();

    expect(onStopNote).toHaveBeenCalledWith(60, "playalong-60");
    expect(engine.getHeldUserPitches()).toEqual(new Set());
  });

  it("starts, advances, and wraps only across eligible A–B steps", () => {
    const notes: Note[] = [
      createMockNote("before", 60, 0.5, 0.8, "right"),
      createMockNote("a", 62, 1.5, 1.8, "right"),
      createMockNote("b", 64, 2.8, 3.1, "right"),
      createMockNote("after", 65, 3.2, 3.5, "right"),
    ];
    const times: number[] = [];
    const engine = new PlayAlongEngine({
      notes,
      transitionDurationMs: 0,
      onTimeChange: (time) => times.push(time),
    });
    engine.setLoopRange({ startSeconds: 1.4, endSeconds: 3 });

    engine.start();
    expect(engine.getCurrentStep()?.timeSeconds).toBe(1.5);
    engine.noteOn(62);
    engine.noteOff(62);
    expect(engine.getCurrentStep()?.timeSeconds).toBe(2.8);
    engine.noteOn(64);
    engine.noteOff(64);
    expect(engine.getCurrentStep()?.timeSeconds).toBe(1.5);
    expect(times).toEqual([1.5, 2.8, 1.5]);

    engine.nextStep();
    expect(engine.getCurrentStep()?.timeSeconds).toBe(2.8);
    engine.nextStep();
    expect(engine.getCurrentStep()?.timeSeconds).toBe(1.5);
    engine.previousStep();
    expect(engine.getCurrentStep()?.timeSeconds).toBe(2.8);
    engine.dispose();
  });

  it("settles an in-flight transition when the A–B range changes", () => {
    const times: number[] = [];
    const engine = new PlayAlongEngine({
      notes: [
        createMockNote("a", 62, 1.5, 1.8, "right"),
        createMockNote("b", 64, 2.8, 3.1, "right"),
      ],
      transitionDurationMs: 5_000,
      onTimeChange: (time) => times.push(time),
    });

    engine.start();
    engine.noteOn(62);
    engine.noteOff(62);
    expect(engine.getState()).toBe("transitioning");

    engine.setLoopRange({ startSeconds: 2.7, endSeconds: 3.2 });

    expect(engine.getState()).toBe("waiting");
    expect(engine.getCurrentStep()?.timeSeconds).toBe(2.8);
    expect(times.at(-1)).toBe(2.8);
    engine.dispose();
  });

  it("completes without audio when A–B contains no playable step", () => {
    const onPlayNote = vi.fn();
    const onStepChange = vi.fn();
    const engine = new PlayAlongEngine({
      notes: [createMockNote("only", 60, 0.5, 0.8, "right")],
      onPlayNote,
      onStepChange,
    });
    engine.setLoopRange({ startSeconds: 1, endSeconds: 2 });
    engine.start();

    expect(engine.hasEligibleLoopSteps()).toBe(false);
    expect(engine.getState()).toBe("completed");
    expect(engine.getCurrentStep()).toBeNull();
    expect(onPlayNote).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("does not schedule companion-note onsets at or beyond loop B", async () => {
    vi.useFakeTimers();
    const notes: Note[] = [
      createMockNote("r1", 60, 1.5, 2.8, "right"),
      createMockNote("r2", 62, 2.5, 2.9, "right"),
      createMockNote("l-before-b", 48, 1.8, 1.95, "left"),
      createMockNote("l-at-b", 50, 2, 2.2, "left"),
      createMockNote("l-after-b", 52, 2.1, 2.3, "left"),
    ];
    const onPlayNote = vi.fn();
    const engine = new PlayAlongEngine({
      notes,
      handMode: "right",
      transitionDurationMs: 0,
      onPlayNote,
    });
    engine.setLoopRange({ startSeconds: 1.4, endSeconds: 2 });
    engine.start();
    engine.noteOn(60);
    await vi.advanceTimersByTimeAsync(700);

    const companionPitches = onPlayNote.mock.calls
      .filter(([, , voiceId]) => String(voiceId).startsWith("playalong-companion-"))
      .map(([pitch]) => pitch);
    expect(companionPitches).toContain(48);
    expect(companionPitches).not.toContain(50);
    expect(companionPitches).not.toContain(52);
    engine.dispose();
  });
});
