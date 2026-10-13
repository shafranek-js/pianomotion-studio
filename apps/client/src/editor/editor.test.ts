import { describe, expect, it } from "vitest";
import type { FingeringPlan, Note, SongDocument } from "@handthesia/contracts";
import {
  createAssignFingerCommand,
  createAssignHandCommand,
  createBatchAssignCommand,
  createClearFingeringCommand,
  createMarkUnplayableCommand,
  createToggleGlissandoCommand,
} from "./commands";
import { calculateDifficulty } from "./difficulty";
import { EditorStateManager, MAX_HISTORY_STEPS } from "./editorState";
import { materializeEditedDocument } from "./materializeEditedDocument";

function createTestSong(partialNotes: Partial<Note>[] = []): SongDocument {
  const notes: Note[] = partialNotes.map((n, i) => ({
    ...n,
    noteId: n.noteId ?? `n${i + 1}`,
    trackId: n.trackId ?? "track-1",
    pitch: n.pitch ?? 60,
    velocity: n.velocity ?? 80,
    startSeconds: n.startSeconds ?? i * 0.5,
    endSeconds: n.endSeconds ?? i * 0.5 + 0.4,
    hand: n.hand ?? "right",
    finger: n.finger !== undefined ? n.finger : 1,
    glissando: n.glissando ?? false,
  }));

  return {
    schemaVersion: 1,
    projectId: "test-project",
    revision: 1,
    title: "Test Sonata",
    durationSeconds: 10,
    tracks: [
      {
        trackId: "track-1",
        instrumentIndex: 0,
        name: "Piano",
        program: 0,
        hand: "right",
      },
    ],
    notes,
    tempoMap: [
      {
        timeSeconds: 0,
        microsecondsPerQuarterNote: 500000,
        eventOrdinal: 0,
      },
    ],
    pedalControls: [],
  };
}

function createTestPlan(song: SongDocument): FingeringPlan {
  return {
    schemaVersion: 1,
    planId: "test-plan",
    projectId: song.projectId,
    inputRevision: song.revision,
    profileId: "default-profile",
    profileRevision: 1,
    engineVersion: "1.0.0",
    diagnostics: [],
    kind: "fingering",
    assignments: song.notes.map((n) => ({
      noteId: n.noteId,
      hand: n.hand,
      finger: n.finger,
      disposition: n.glissando
        ? ("glissando" as const)
        : n.finger !== null
        ? ("played" as const)
        : ("unplayable" as const),
    })),
  };
}

describe("Editor Commands", () => {
  it("createAssignHandCommand assigns hand and increments inputRevision", () => {
    const song = createTestSong([
      { noteId: "n1", hand: "right" },
      { noteId: "n2", hand: "right" },
    ]);
    const plan = createTestPlan(song);

    const cmd = createAssignHandCommand(["n1"], "left");
    const nextPlan = cmd.apply(plan);

    expect(nextPlan.inputRevision).toBe(plan.inputRevision + 1);
    expect(nextPlan.assignments[0]!.hand).toBe("left");
    expect(nextPlan.assignments[1]!.hand).toBe("right"); // Preserved
  });

  it("createAssignFingerCommand assigns finger and updates disposition", () => {
    const song = createTestSong([
      { noteId: "n1", finger: 1 },
      { noteId: "n2", finger: 2 },
    ]);
    const plan = createTestPlan(song);

    // Assign finger 4
    const cmd1 = createAssignFingerCommand(["n1"], 4);
    const plan1 = cmd1.apply(plan);
    expect(plan1.assignments[0]!.finger).toBe(4);
    expect(plan1.assignments[0]!.disposition).toBe("played");

    // Assign null clears the manual override and leaves the note eligible for replanning.
    const cmd2 = createAssignFingerCommand(["n1"], null);
    const plan2 = cmd2.apply(plan1);
    expect(plan2.assignments[0]!.finger).toBe(4);
    expect(plan2.assignments[0]!.fingerMode).toBe("automatic");
    expect(plan2.assignments[0]!.disposition).toBe("played");
  });

  it("createToggleGlissandoCommand toggles glissando disposition and finger", () => {
    const song = createTestSong([{ noteId: "n1", finger: 3, glissando: false }]);
    const plan = createTestPlan(song);

    // Toggle ON
    const cmdToggleOn = createToggleGlissandoCommand(["n1"]);
    const planGliss = cmdToggleOn.apply(plan);
    expect(planGliss.assignments[0]!.disposition).toBe("glissando");
    expect(planGliss.assignments[0]!.finger).toBeNull();

    // Toggle OFF
    const cmdToggleOff = createToggleGlissandoCommand(["n1"]);
    const planOff = cmdToggleOff.apply(planGliss);
    expect(planOff.assignments[0]!.disposition).toBe("played");
    expect(planOff.assignments[0]!.finger).toBeGreaterThanOrEqual(1);
  });

  it("createClearFingeringCommand clears the manual override for automatic replanning", () => {
    const song = createTestSong([{ noteId: "n1", finger: 5 }]);
    const plan = createTestPlan(song);

    const cmd = createClearFingeringCommand(["n1"]);
    const cleared = cmd.apply(plan);

    expect(cleared.assignments[0]!.finger).toBe(5);
    expect(cleared.assignments[0]!.fingerMode).toBe("automatic");
    expect(cleared.assignments[0]!.disposition).toBe("played");
    expect(cleared.inputRevision).toBe(plan.inputRevision + 1);
  });

  it("marks a note unplayable only through the explicit command", () => {
    const plan = createTestPlan(createTestSong([{ noteId: "n1", finger: 5 }]));
    const result = createMarkUnplayableCommand(["n1"]).apply(plan);
    expect(result.assignments[0]!.finger).toBeNull();
    expect(result.assignments[0]!.disposition).toBe("unplayable");
  });

  it("createBatchAssignCommand updates multiple properties atomically", () => {
    const song = createTestSong([
      { noteId: "n1", hand: "right", finger: 1 },
      { noteId: "n2", hand: "left", finger: 5 },
    ]);
    const plan = createTestPlan(song);

    const cmd = createBatchAssignCommand([
      { noteId: "n1", hand: "left", finger: 3 },
      { noteId: "n2", finger: 1 },
    ]);
    const updated = cmd.apply(plan);

    expect(updated.assignments[0]!.hand).toBe("left");
    expect(updated.assignments[0]!.finger).toBe(3);
    expect(updated.assignments[1]!.hand).toBe("left");
    expect(updated.assignments[1]!.finger).toBe(1);
  });
});

describe("EditorStateManager History (Undo / Redo)", () => {
  it("provides 100% reversible undo / redo history", () => {
    const song = createTestSong([
      { noteId: "n1", finger: 1 },
      { noteId: "n2", finger: 2 },
    ]);
    const initialPlan = createTestPlan(song);
    const manager = new EditorStateManager({ initialPlan, document: song });

    expect(manager.canUndo).toBe(false);
    expect(manager.canRedo).toBe(false);

    // Edit 1: change n1 finger to 3
    manager.executeCommand(createAssignFingerCommand(["n1"], 3));
    expect(manager.currentPlan.assignments[0]!.finger).toBe(3);
    expect(manager.canUndo).toBe(true);
    expect(manager.canRedo).toBe(false);

    // Edit 2: change n2 finger to 4
    manager.executeCommand(createAssignFingerCommand(["n2"], 4));
    expect(manager.currentPlan.assignments[1]!.finger).toBe(4);

    // Undo 1 step
    const undone1 = manager.undo();
    expect(undone1?.assignments[1]!.finger).toBe(2);
    expect(manager.canUndo).toBe(true);
    expect(manager.canRedo).toBe(true);

    // Undo 2nd step (back to initial)
    const undone2 = manager.undo();
    expect(undone2?.assignments[0]!.finger).toBe(1);
    expect(manager.canUndo).toBe(false);
    expect(manager.canRedo).toBe(true);

    // Redo 1 step
    const redone1 = manager.redo();
    expect(redone1?.assignments[0]!.finger).toBe(3);
    expect(manager.canUndo).toBe(true);
    expect(manager.canRedo).toBe(true);

    // Redo 2nd step
    const redone2 = manager.redo();
    expect(redone2?.assignments[1]!.finger).toBe(4);
    expect(manager.canUndo).toBe(true);
    expect(manager.canRedo).toBe(false);
  });

  it("invalidates redo stack upon a new edit after undo", () => {
    const song = createTestSong([{ noteId: "n1", finger: 1 }]);
    const initialPlan = createTestPlan(song);
    const manager = new EditorStateManager({ initialPlan, document: song });

    manager.executeCommand(createAssignFingerCommand(["n1"], 2));
    manager.undo();
    expect(manager.canRedo).toBe(true);

    // New edit should clear redo stack
    manager.executeCommand(createAssignFingerCommand(["n1"], 5));
    expect(manager.canRedo).toBe(false);
    expect(manager.currentPlan.assignments[0]!.finger).toBe(5);
  });

  it("caps undo history stack at MAX_HISTORY_STEPS (50)", () => {
    const song = createTestSong([{ noteId: "n1", finger: 1 }]);
    const initialPlan = createTestPlan(song);
    const manager = new EditorStateManager({ initialPlan, document: song });

    for (let i = 0; i < 60; i += 1) {
      manager.executeCommand(createAssignFingerCommand(["n1"], (i % 5) + 1));
    }

    expect(manager.past.length).toBe(MAX_HISTORY_STEPS);
  });
});

describe("EditorStateManager Sequential Step Entry & Keyboard Shortcuts", () => {
  it("advances selection to the next chronological note when stepEntryMode is ON", () => {
    const song = createTestSong([
      { noteId: "n1", startSeconds: 0.0, pitch: 60 },
      { noteId: "n2", startSeconds: 0.5, pitch: 62 },
      { noteId: "n3", startSeconds: 1.0, pitch: 64 },
    ]);
    const plan = createTestPlan(song);
    const manager = new EditorStateManager({
      initialPlan: plan,
      document: song,
      stepEntryMode: true,
    });

    manager.selectNote("n1");
    expect(manager.selectedNoteIds.has("n1")).toBe(true);

    // Assign finger 3 to n1 -> should auto advance to n2!
    manager.executeCommand(createAssignFingerCommand(["n1"], 3));
    expect(manager.selectedNoteIds.has("n2")).toBe(true);
    expect(manager.selectedNoteIds.has("n1")).toBe(false);

    // Assign finger 4 to n2 -> should auto advance to n3!
    manager.executeCommand(createAssignFingerCommand(["n2"], 4));
    expect(manager.selectedNoteIds.has("n3")).toBe(true);
  });

  it("does not advance selection when stepEntryMode is OFF", () => {
    const song = createTestSong([
      { noteId: "n1", startSeconds: 0.0 },
      { noteId: "n2", startSeconds: 0.5 },
    ]);
    const plan = createTestPlan(song);
    const manager = new EditorStateManager({
      initialPlan: plan,
      document: song,
      stepEntryMode: false,
    });

    manager.selectNote("n1");
    manager.executeCommand(createAssignFingerCommand(["n1"], 3));

    expect(manager.selectedNoteIds.has("n1")).toBe(true);
    expect(manager.selectedNoteIds.has("n2")).toBe(false);
  });

  it("handles keyboard shortcuts accurately", () => {
    const song = createTestSong([
      { noteId: "n1", startSeconds: 0.0, pitch: 60 },
      { noteId: "n2", startSeconds: 0.5, pitch: 62 },
    ]);
    const plan = createTestPlan(song);
    const manager = new EditorStateManager({
      initialPlan: plan,
      document: song,
      stepEntryMode: false,
    });

    manager.selectNote("n1");

    // Key '3' -> assigns finger 3
    let handled = manager.handleKeyDown({ key: "3" });
    expect(handled).toBe(true);
    expect(manager.currentPlan.assignments[0]!.finger).toBe(3);

    // Key 'l' -> assigns left hand
    handled = manager.handleKeyDown({ key: "l" });
    expect(handled).toBe(true);
    expect(manager.currentPlan.assignments[0]!.hand).toBe("left");

    // Key 'g' -> toggles glissando
    handled = manager.handleKeyDown({ key: "g" });
    expect(handled).toBe(true);
    expect(manager.currentPlan.assignments[0]!.disposition).toBe("glissando");

    // Key '0' -> returns to automatic fingering; Delete is the separate omission action.
    handled = manager.handleKeyDown({ key: "0" });
    expect(handled).toBe(true);
    expect(manager.currentPlan.assignments[0]!.fingerMode).toBe("automatic");
    expect(manager.currentPlan.assignments[0]!.disposition).toBe("glissando");

    // Ctrl+Z -> undo
    handled = manager.handleKeyDown({ key: "z", ctrlKey: true });
    expect(handled).toBe(true);
    expect(manager.currentPlan.assignments[0]!.disposition).toBe("played");

    // ArrowRight -> advance selection to n2
    handled = manager.handleKeyDown({ key: "ArrowRight" });
    expect(handled).toBe(true);
    expect(manager.selectedNoteIds.has("n2")).toBe(true);

    handled = manager.handleKeyDown({ key: "Delete" });
    expect(handled).toBe(true);
    expect(manager.currentPlan.assignments[1]!.disposition).toBe("unplayable");
  });

  it("does not publish selection or navigation as fingering edits", () => {
    const song = createTestSong([{ noteId: "n1" }, { noteId: "n2", startSeconds: 1 }]);
    const manager = new EditorStateManager({ initialPlan: createTestPlan(song), document: song });
    const events: string[] = [];
    manager.subscribe((_plan, kind) => events.push(kind));

    manager.selectNote("n1");
    manager.advanceSelection("next");
    expect(events).toEqual(["view", "view"]);

    manager.assignFinger(3);
    expect(events.at(-1)).toBe("edit");
    expect(events.filter((kind) => kind === "edit")).toHaveLength(1);
  });

  it("keeps history and selection when a parent plan arrives and gives undo a fresh revision", () => {
    const song = createTestSong([{ noteId: "n1", finger: 1 }, { noteId: "n2", finger: 2 }]);
    const manager = new EditorStateManager({ initialPlan: createTestPlan(song), document: song });
    manager.selectNote("n2");
    manager.assignFinger(4);
    const editRevision = manager.currentPlan.inputRevision;

    const upstream = {
      ...manager.currentPlan,
      planId: "upstream-plan",
      assignments: manager.currentPlan.assignments.map((assignment) => assignment.noteId === "n1"
        ? { ...assignment, finger: 5 }
        : assignment),
    };
    expect(manager.reconcileExternalPlan(upstream)).toBe(true);
    expect(manager.canUndo).toBe(true);
    expect(manager.selectedNoteIds.has("n2")).toBe(true);

    const undone = manager.undo();
    expect(undone?.inputRevision).toBeGreaterThan(editRevision);
    expect(manager.canRedo).toBe(true);
  });

  it("keeps manual, automatic-clear, and gliss intent through replan cycles and undo", () => {
    const song = createTestSong([
      { noteId: "manual-note", finger: 2 },
      { noteId: "automatic-note", finger: 5 },
      { noteId: "gliss-note", finger: 4 },
    ]);
    const manager = new EditorStateManager({ initialPlan: createTestPlan(song), document: song });
    let document = song;
    let replanCount = 0;

    const applyParentReplan = () => {
      const submittedPlan = manager.currentPlan;
      document = materializeEditedDocument(
        { ...document, revision: submittedPlan.inputRevision },
        submittedPlan,
      );
      manager.setDocument(document);

      // The Python response supplies fresh computed plan identities and values
      // while echoing explicit intent flags by the persistent note ID.
      const returnedPlan: FingeringPlan = {
        ...submittedPlan,
        planId: `replan-result-${++replanCount}`,
        assignments: submittedPlan.assignments.map((assignment) => ({ ...assignment })),
      };
      expect(manager.reconcileExternalPlan(returnedPlan)).toBe(true);
      return returnedPlan;
    };

    manager.executeCommand(createAssignFingerCommand(["manual-note"], 4));
    manager.executeCommand(createClearFingeringCommand(["automatic-note"]));
    manager.executeCommand(createToggleGlissandoCommand(["gliss-note"]));
    const firstReplan = applyParentReplan();
    expect(firstReplan.assignments.find((assignment) => assignment.noteId === "manual-note"))
      .toMatchObject({ finger: 4, fingerMode: "manual", glissMode: "manual" });
    expect(firstReplan.assignments.find((assignment) => assignment.noteId === "automatic-note"))
      .toMatchObject({ fingerMode: "automatic" });
    expect(firstReplan.assignments.find((assignment) => assignment.noteId === "gliss-note"))
      .toMatchObject({ disposition: "glissando", fingerMode: "automatic", glissMode: "manual" });

    manager.executeCommand(createAssignFingerCommand(["manual-note"], 3));
    manager.executeCommand(createAssignFingerCommand(["automatic-note"], 2));
    manager.executeCommand(createToggleGlissandoCommand(["gliss-note"]));
    const secondReplan = applyParentReplan();
    expect(secondReplan.assignments.find((assignment) => assignment.noteId === "manual-note"))
      .toMatchObject({ finger: 3, fingerMode: "manual", glissMode: "manual" });
    expect(secondReplan.assignments.find((assignment) => assignment.noteId === "automatic-note"))
      .toMatchObject({ fingerMode: "manual", glissMode: "manual" });
    expect(secondReplan.assignments.find((assignment) => assignment.noteId === "gliss-note"))
      .toMatchObject({ disposition: "played", fingerMode: "automatic", glissMode: "manual" });

    const undoneGliss = manager.undo()!;
    document = materializeEditedDocument({ ...document, revision: undoneGliss.inputRevision }, undoneGliss);
    expect(document.notes.find((note) => note.noteId === "gliss-note")?.glissando).toBe(true);

    const undoneClear = manager.undo()!;
    document = materializeEditedDocument({ ...document, revision: undoneClear.inputRevision }, undoneClear);
    expect(undoneClear.assignments.find((assignment) => assignment.noteId === "automatic-note")?.fingerMode)
      .toBe("automatic");
    expect(document.notes.find((note) => note.noteId === "automatic-note")?.finger).toBeNull();

    const undoneManual = manager.undo()!;
    document = materializeEditedDocument({ ...document, revision: undoneManual.inputRevision }, undoneManual);
    expect(document.notes.find((note) => note.noteId === "manual-note")?.finger).toBe(4);
  });

  it("materializes hand, manual finger, automatic finger, and gliss edits by stable note ID", () => {
    const song = createTestSong([
      {
        noteId: "stable-source-note-1",
        sourceNoteIds: ["decoded-alias-1"],
        sourceEvent: { midiTrackIndex: 2, channel: 0, noteOnOrdinal: 10, noteOffOrdinal: 11 },
        hand: "right",
        finger: 1,
      },
      {
        noteId: "stable-source-note-2",
        sourceNoteIds: ["decoded-alias-2"],
        sourceEvent: { midiTrackIndex: 2, channel: 0, noteOnOrdinal: 12, noteOffOrdinal: 13 },
        hand: "right",
        finger: 2,
      },
      {
        noteId: "stable-source-note-3",
        sourceNoteIds: ["decoded-alias-3"],
        sourceEvent: { midiTrackIndex: 2, channel: 0, noteOnOrdinal: 14, noteOffOrdinal: 15 },
        hand: "left",
        finger: 3,
      },
    ]);
    song.sourceMidiResourceId = "midi-resource-original";
    const initialPlan = createTestPlan(song);
    const manager = new EditorStateManager({ initialPlan, document: song });
    manager.executeCommand(createAssignHandCommand(["stable-source-note-1"], "left"));
    manager.executeCommand(createAssignFingerCommand(["stable-source-note-2"], 4));
    manager.executeCommand(createClearFingeringCommand(["stable-source-note-3"]));
    manager.executeCommand(createToggleGlissandoCommand(["stable-source-note-1"]));

    const editedDocument = materializeEditedDocument(
      { ...song, revision: manager.currentPlan.inputRevision },
      manager.currentPlan,
    );
    expect(editedDocument.sourceMidiResourceId).toBe("midi-resource-original");
    expect(editedDocument.notes.map((note) => note.noteId)).toEqual(song.notes.map((note) => note.noteId));
    expect(editedDocument.notes.map((note) => note.sourceNoteIds)).toEqual(song.notes.map((note) => note.sourceNoteIds));
    expect(editedDocument.notes.map((note) => note.sourceEvent)).toEqual(song.notes.map((note) => note.sourceEvent));
    expect(editedDocument.notes[0]).toMatchObject({ hand: "left", finger: null, glissando: true });
    expect(editedDocument.notes[1]).toMatchObject({ hand: "right", finger: 4, glissando: false });
    expect(editedDocument.notes[2]).toMatchObject({ hand: "left", finger: null, glissando: false });
  });

  it("keeps an untouched source document byte-for-JSON identical to its editor materialization", () => {
    const song = createTestSong([
      { noteId: "original-manual", finger: 4, glissando: true },
      { noteId: "original-auto", finger: null, glissando: false },
    ]);
    song.sourceMidiResourceId = "original-resource";
    const plan = createTestPlan(song);
    // A computed gliss disposition can differ from the document's explicit
    // marker on a solitary note. It must not become a document edit implicitly.
    plan.assignments[0]!.finger = null;
    plan.assignments[1]!.disposition = "glissando";
    plan.assignments[1]!.finger = null;

    const materialized = materializeEditedDocument(song, plan);
    expect(materialized).toEqual(song);
    expect(JSON.stringify(materialized)).toBe(JSON.stringify(song));
  });
});

describe("Difficulty & Ergonomics Calculation (W031)", () => {
  it("calculates difficulty on an empty song document", () => {
    const song = createTestSong([]);
    const plan = createTestPlan(song);
    const report = calculateDifficulty(song, plan);

    expect(report.overallScore).toBe(1.0);
    expect(report.tier).toBe("Beginner");
    expect(report.maxStretchSemitones).toBe(0);
    expect(report.maxSpeedNotesPerSec).toBe(0);
    expect(report.handCrossingsCount).toBe(0);
    expect(report.awkwardFingeringCount).toBe(0);
    expect(report.summary).toContain("Empty song document");
  });

  it("calculates max stretch semitones for concurrent chord notes in same hand", () => {
    const song = createTestSong([
      // Chord in right hand: C4 (60) and E5 (76) -> 16 semitones (tenth)
      { noteId: "c1", pitch: 60, startSeconds: 0, endSeconds: 1, hand: "right", finger: 1 },
      { noteId: "c2", pitch: 76, startSeconds: 0, endSeconds: 1, hand: "right", finger: 5 },
    ]);
    const plan = createTestPlan(song);
    const report = calculateDifficulty(song, plan);

    expect(report.maxStretchSemitones).toBe(16);
  });

  it("calculates peak speed (notes per second) accurately", () => {
    // 8 fast notes in 0.8 seconds (within 1-second window)
    const fastNotes: Partial<Note>[] = Array.from({ length: 8 }, (_, i) => ({
      noteId: `fast-${i}`,
      startSeconds: i * 0.1,
      endSeconds: i * 0.1 + 0.08,
      pitch: 60 + i,
      hand: "right" as const,
      finger: ((i % 5) + 1),
    }));

    const song = createTestSong(fastNotes);
    const plan = createTestPlan(song);
    const report = calculateDifficulty(song, plan);

    expect(report.maxSpeedNotesPerSec).toBe(8);
  });

  it("detects hand crossing episodes", () => {
    const song = createTestSong([
      // Left hand at pitch 72 (C5), Right hand at pitch 60 (C4) sounding together
      { noteId: "lh1", pitch: 72, startSeconds: 0.0, endSeconds: 1.0, hand: "left", finger: 1 },
      { noteId: "rh1", pitch: 60, startSeconds: 0.0, endSeconds: 1.0, hand: "right", finger: 1 },
    ]);
    const plan = createTestPlan(song);
    const report = calculateDifficulty(song, plan);

    expect(report.handCrossingsCount).toBe(1);
  });

  it("detects awkward transitions such as thumb on black key with adjacent white cross", () => {
    const song = createTestSong([
      // Thumb (finger 1) on C#4 (61 - black key), followed 0.15s later by finger 2 on D4 (62 - white key)
      { noteId: "n1", pitch: 61, startSeconds: 0.0, endSeconds: 0.2, hand: "right", finger: 1 },
      { noteId: "n2", pitch: 62, startSeconds: 0.15, endSeconds: 0.35, hand: "right", finger: 2 },
    ]);
    const plan = createTestPlan(song);
    const report = calculateDifficulty(song, plan);

    expect(report.awkwardFingeringCount).toBeGreaterThan(0);
  });

  it("assigns appropriate tier based on overall score", () => {
    // Simple slow piece
    const simpleSong = createTestSong([
      { noteId: "s1", pitch: 60, startSeconds: 0, endSeconds: 1, hand: "right", finger: 1 },
      { noteId: "s2", pitch: 62, startSeconds: 2, endSeconds: 3, hand: "right", finger: 2 },
    ]);
    const simplePlan = createTestPlan(simpleSong);
    const simpleReport = calculateDifficulty(simpleSong, simplePlan);

    expect(simpleReport.overallScore).toBeLessThan(3.5);
    expect(simpleReport.tier).toBe("Beginner");
  });
});
