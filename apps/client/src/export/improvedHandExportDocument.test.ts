import { describe, expect, it } from "vitest";
import type { FingeringPlan, SongDocument } from "@handthesia/contracts";
import { materializeImprovedHandExportDocument } from "./improvedHandExportDocument";

const sourceDocument = {
  schemaVersion: 1,
  projectId: "project-1",
  revision: 7,
  title: "Frozen source",
  durationSeconds: 3,
  tracks: [],
  notes: [
    { noteId: "note-played", trackId: "track-1", pitch: 60, velocity: 100, startSeconds: 0, endSeconds: 1,
      hand: "right", finger: 1, glissando: false },
    { noteId: "note-unplayed", trackId: "track-1", pitch: 61, velocity: 100, startSeconds: 1, endSeconds: 2,
      hand: "right", finger: 5, glissando: false },
    { noteId: "note-without-assignment", trackId: "track-1", pitch: 62, velocity: 100, startSeconds: 2, endSeconds: 3,
      hand: "left", finger: 2, glissando: false },
  ],
  tempoMap: [],
  pedalControls: [],
} satisfies SongDocument;

const frozenPlan = {
  schemaVersion: 1,
  kind: "fingering",
  planId: "plan-1",
  projectId: "project-1",
  inputRevision: 7,
  profileId: "profile-1",
  profileRevision: 1,
  engineVersion: "engine-1",
  diagnostics: [],
  assignments: [
    { noteId: "note-played", hand: "left", finger: 4, disposition: "played" },
    { noteId: "note-unplayed", hand: "left", finger: null, disposition: "unplayable" },
    { noteId: "missing-source-note", hand: "right", finger: 3, disposition: "played" },
  ],
} satisfies FingeringPlan;

describe("improved hand export document", () => {
  it("projects frozen note assignments by ID without mutating the source or its revision", () => {
    const sourceBefore = structuredClone(sourceDocument);

    const sceneDocument = materializeImprovedHandExportDocument(sourceDocument, frozenPlan);

    expect(sceneDocument).not.toBe(sourceDocument);
    expect(sceneDocument.projectId).toBe(sourceDocument.projectId);
    expect(sceneDocument.revision).toBe(sourceDocument.revision);
    expect(sceneDocument.notes[0]).toMatchObject({ noteId: "note-played", hand: "left", finger: 4 });
    expect(sceneDocument.notes[1]).toMatchObject({ noteId: "note-unplayed", hand: "left", finger: null });
    expect(sceneDocument.notes[2]).toBe(sourceDocument.notes[2]);
    expect(sourceDocument).toEqual(sourceBefore);
  });
});
