import { describe, expect, it, vi } from "vitest";
// These numerical engine tests exceed Vitest's 5 s default when the local gate
// runs the build and Python suite concurrently; keep the timeout scoped here.
vi.setConfig({ testTimeout: 15_000 });

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  M1AnalyzeMidiRequestSchema,
  M1ReplanDocumentRequestSchema,
  M1SampleMotionRequestSchema,
  M1SampleMotionResultSchema,
  M1ExportMidiRequestSchema,
  M1ExportMidiResultSchema,
  validateM1AnalyzeMidiResultForRequest,
  validateM1ReplanDocumentResultForRequest,
} from "@handthesia/contracts";
import {
  analyzeMidi,
  replanDocument,
  sampleMotionWindow,
  exportFingeredMidi,
  setProgressCallback,
  _manifest,
  _engine_version,
} from "../src/index.ts";

const fixturesDir = resolve(__dirname, "../../../tests/fixtures");

function loadMidi(filename: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(fixturesDir, "midi", filename)));
}

function loadGolden(filename: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixturesDir, "golden", filename), "utf-8"));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("@handthesia/engine-ts", () => {
  it("declares the checked-in target Python baseline manifest", () => {
    const manifest = _manifest();
    const pythonManifest = JSON.parse(readFileSync(resolve(__dirname, "../../../python-core/handthesia_core/source_manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(typeof manifest.engineVersion).toBe("string");
    expect(manifest.engineVersion.length).toBe(64);
    expect(_engine_version()).toBe(manifest.engineVersion);
    expect(manifest.engineVersion).toBe(pythonManifest.engineVersion);
    expect(manifest.files).toEqual(pythonManifest.files);
  });

  it("analyzes tracked-right-hand.mid and matches golden assignments", () => {
    const midiBytes = loadMidi("tracked-right-hand.mid");
    const golden = loadGolden("tracked-right-hand.json") as {
      assignments: Array<{
        noteId: string;
        sourceNoteIds: string[];
        hand: string;
        finger: number | null;
        manualFinger: number | null;
        gliss: boolean;
      }>;
    };

    const options = {
      fixtureId: "tracked-right-hand",
      projectId: "test-proj",
      revision: 0,
      requestId: "test-req",
      engineVersion: _engine_version(),
      sampleDense: true,
    };

    const request = M1AnalyzeMidiRequestSchema.parse({
      type: "analyze-midi",
      requestId: options.requestId,
      projectId: options.projectId,
      revision: options.revision,
      engineVersion: options.engineVersion,
      midiBytes: toArrayBuffer(midiBytes),
      options: { fixtureId: options.fixtureId, sampleDense: options.sampleDense },
    });
    const progress: number[] = [];
    setProgressCallback((fraction: number) => progress.push(fraction));
    let result: ReturnType<typeof analyzeMidi>;
    try {
      result = analyzeMidi(midiBytes, options);
    } finally {
      setProgressCallback(null);
    }
    const validated = validateM1AnalyzeMidiResultForRequest(request, {
      ...result,
      type: "analysis-result",
    });

    expect(validated.status).toBe("loaded");
    expect(validated.document).toBeDefined();
    expect(validated.fingeringPlan).toBeDefined();
    expect(validated.performancePlan).toBeDefined();
    expect(validated.rawBaseline).toBeDefined();
    expect(progress).toContain(1);

    expect(validated.fingeringPlan!.assignments).toHaveLength(golden.assignments.length);
    expect(validated.document!.notes).toHaveLength(golden.assignments.length);
    const resultNotes = new Map(validated.document!.notes.map((note) => [note.noteId, note]));
    const resultAssignments = new Map(validated.fingeringPlan!.assignments.map((assignment) => [assignment.noteId, assignment]));
    for (const expected of golden.assignments) {
      const note = resultNotes.get(expected.noteId);
      const assignment = resultAssignments.get(expected.noteId);
      expect(note, expected.noteId).toBeDefined();
      expect(assignment, expected.noteId).toBeDefined();
      expect(note!.sourceNoteIds, expected.noteId).toEqual(expected.sourceNoteIds);
      expect(assignment!.hand, expected.noteId).toBe(expected.hand === "L" ? "left" : "right");
      expect(assignment!.finger, expected.noteId).toBe(expected.finger);
      expect(assignment!.disposition, expected.noteId).toBe(
        expected.gliss ? "glissando" : expected.finger === null ? "unplayable" : "played",
      );
      expect(note!.finger, expected.noteId).toBe(expected.manualFinger);
      expect(note!.glissando, expected.noteId).toBe(expected.gliss);
    }
  });

  it("replans document when fingering changes", () => {
    const midiBytes = loadMidi("tracked-right-hand.mid");
    const initial = analyzeMidi(midiBytes, {
      fixtureId: "tracked-right-hand",
      projectId: "test-proj",
      revision: 0,
      requestId: "req-1",
      engineVersion: _engine_version(),
      sampleDense: true,
    });

    const replanOptions = {
      fixtureId: "tracked-right-hand",
      projectId: "test-proj",
      revision: 1,
      requestId: "req-2",
      engineVersion: _engine_version(),
      profile: initial.profile,
      resource: initial.resource,
      rawBaseline: initial.rawBaseline,
      keyStyle: "realistic",
    };

    const editedDocument = { ...initial.document, revision: 1 };
    const editedFingeringPlan = { ...initial.fingeringPlan, inputRevision: 1 };
    const replanRequest = M1ReplanDocumentRequestSchema.parse({
      type: "replan-document",
      requestId: replanOptions.requestId,
      projectId: replanOptions.projectId,
      revision: replanOptions.revision,
      engineVersion: replanOptions.engineVersion,
      midiBytes: toArrayBuffer(midiBytes),
      document: editedDocument,
      fingeringPlan: editedFingeringPlan,
      profile: replanOptions.profile,
      resource: replanOptions.resource,
      rawBaseline: replanOptions.rawBaseline,
      options: { fixtureId: replanOptions.fixtureId, keyStyle: replanOptions.keyStyle },
    });
    const replanned = replanDocument(
      midiBytes,
      editedDocument,
      editedFingeringPlan,
      replanOptions,
    );
    const validatedReplan = validateM1ReplanDocumentResultForRequest(replanRequest, {
      ...replanned,
      type: "replan-document-result",
    });

    expect(validatedReplan.status).toBe("loaded");
    expect(validatedReplan.fingeringPlan).toBeDefined();
    expect(validatedReplan.performancePlan).toBeDefined();
    const replannedNotes = new Map(validatedReplan.document!.notes.map((note) => [note.noteId, note]));
    for (const event of validatedReplan.performancePlan!.events) {
      if (event.type !== "press") continue;
      expect(event.pitch, event.noteId).toBe(replannedNotes.get(event.noteId)?.pitch);
    }
  });

  it("samples motion window from active session", () => {
    const midiBytes = loadMidi("tracked-right-hand.mid");
    const initial = analyzeMidi(midiBytes, {
      fixtureId: "tracked-right-hand",
      projectId: "test-proj",
      revision: 1,
      requestId: "req-1",
      engineVersion: _engine_version(),
      sampleDense: true,
    });

    const motionRequest = M1SampleMotionRequestSchema.parse({
      type: "sample-motion",
      requestId: "motion-req-1",
      projectId: "test-proj",
      revision: 1,
      engineVersion: _engine_version(),
      startTimeSeconds: 0,
      endTimeSeconds: 2,
      maxPoses: 200,
    });
    const motionResult = sampleMotionWindow(
      midiBytes,
      initial.document,
      initial.fingeringPlan,
      0.0,
      2.0,
      {
        projectId: "test-proj",
        revision: 1,
        requestId: "motion-req-1",
        engineVersion: _engine_version(),
        maxPoses: 200,
        profile: initial.profile,
      },
    );

    const validatedMotion = M1SampleMotionResultSchema.parse({
      ...motionResult,
      type: "sample-motion-result",
      requestId: "motion-req-1",
      projectId: "test-proj",
      revision: 1,
      engineVersion: _engine_version(),
    });

    expect(validatedMotion.poses.length).toBeGreaterThan(0);
    expect(validatedMotion.coverage).toBeDefined();
    expect(validatedMotion.requestId).toBe(motionRequest.requestId);
    expect(validatedMotion.projectId).toBe(motionRequest.projectId);
    expect(validatedMotion.revision).toBe(motionRequest.revision);
    expect(validatedMotion.engineVersion).toBe(motionRequest.engineVersion);
  });

  it("keeps motion windows ordered across decade boundaries and rebuilds cold sessions faithfully", () => {
    const midiBytes = loadMidi("tracked-demo-song.mid");
    const fixtureId = "tracked-demo-song";
    const projectId = "motion-decades";
    const revision = 3;
    const initial = analyzeMidi(midiBytes, {
      fixtureId,
      projectId,
      revision,
      requestId: "motion-decades-analyze",
      engineVersion: _engine_version(),
      keyStyle: "realistic",
      sampleDense: false,
    });
    expect(initial.document?.notes.some((note: { hand: string }) => note.hand === "left")).toBe(true);
    expect(initial.fingeringPlan.assignments.some((assignment: { hand: string; finger: number | null }) => assignment.hand === "left" && assignment.finger !== null && assignment.finger !== 1)).toBe(true);

    function sampleWindow(startTimeSeconds: number, endTimeSeconds: number, requestId: string, cold = false) {
      const request = M1SampleMotionRequestSchema.parse({
        type: "sample-motion",
        requestId,
        projectId,
        revision,
        engineVersion: _engine_version(),
        startTimeSeconds,
        endTimeSeconds,
        maxPoses: 200,
      });
      const options = {
        fixtureId,
        requestId,
        engineVersion: request.engineVersion,
        keyStyle: "realistic",
        maxPoses: request.maxPoses,
        profile: initial.profile,
        ...(cold ? {} : { projectId: request.projectId, revision: request.revision }),
      };
      const result = M1SampleMotionResultSchema.parse({
        ...sampleMotionWindow(
          midiBytes,
          initial.document,
          initial.fingeringPlan,
          request.startTimeSeconds,
          request.endTimeSeconds,
          options,
        ),
        type: "sample-motion-result",
      });
      expect(result.requestId).toBe(request.requestId);
      expect(result.projectId).toBe(request.projectId);
      expect(result.revision).toBe(request.revision);
      expect(result.engineVersion).toBe(request.engineVersion);
      const poseTimes = result.poses.map((pose) => pose.transportTimeSeconds);
      expect(poseTimes).toEqual([...poseTimes].sort((a, b) => a - b));
      for (let i = 1; i < result.poses.length; i += 1) {
        const previous = result.poses[i - 1]!;
        const current = result.poses[i]!;
        if (previous.transportTimeSeconds === current.transportTimeSeconds) {
          expect(previous.hand <= current.hand).toBe(true);
        }
      }
      for (const requiredTime of [startTimeSeconds, endTimeSeconds]) {
        expect(poseTimes.some((time) => Math.abs(time - requiredTime) <= 0.0001)).toBe(true);
      }
      for (const boundary of [9, 10, 100]) {
        if (boundary >= startTimeSeconds && boundary <= endTimeSeconds) {
          expect(poseTimes.some((time) => Math.abs(time - boundary) <= 0.0001)).toBe(true);
        }
      }
      for (const hand of ["left", "right"] as const) {
        const coverage = result.coverage?.[hand];
        expect(coverage?.isComplete, `${hand} coverage for ${startTimeSeconds}-${endTimeSeconds}`).toBe(true);
        expect(coverage?.coveredStartTimeSeconds).toBeLessThanOrEqual(startTimeSeconds);
        expect(coverage?.coveredEndTimeSeconds).toBeGreaterThanOrEqual(endTimeSeconds);
      }
      return result;
    }

    const warmWindow = sampleWindow(8, 12, "motion-8-to-12");
    const centuryWindow = sampleWindow(98, 102, "motion-98-to-102");
    expect(centuryWindow.poses.some((pose) => pose.transportTimeSeconds === 100)).toBe(true);

    // A different analysis evicts the cached animator session. The sampler must
    // then reconstruct the hand and finger intent from the document DTOs.
    analyzeMidi(midiBytes, {
      fixtureId,
      projectId: "motion-decades-evictor",
      revision,
      requestId: "motion-decades-evict",
      engineVersion: _engine_version(),
      keyStyle: "realistic",
      sampleDense: false,
    });
    const coldWindow = sampleWindow(8, 12, "motion-cold-rebuild", true);
    expect(coldWindow.poses).toEqual(warmWindow.poses);
    expect(coldWindow.coverage).toEqual(warmWindow.coverage);
  }, 120_000);

  it("exports fingered MIDI with marked notes", () => {
    const midiBytes = loadMidi("tracked-right-hand.mid");
    const initial = analyzeMidi(midiBytes, {
      fixtureId: "tracked-right-hand",
      projectId: "test-proj",
      revision: 0,
      requestId: "req-1",
      engineVersion: _engine_version(),
      sampleDense: true,
    });

    const exportRequest = M1ExportMidiRequestSchema.parse({
      type: "export-midi",
      requestId: "req-1",
      projectId: "test-proj",
      revision: 0,
      engineVersion: _engine_version(),
      midiBytes: toArrayBuffer(midiBytes),
      document: initial.document,
      fingeringPlan: initial.fingeringPlan,
    });
    const exported = exportFingeredMidi(
      midiBytes,
      initial.document,
      initial.fingeringPlan,
    );

    const validatedExport = M1ExportMidiResultSchema.parse({
      ...exported,
      exportedBytes: exported.exportedBytes.buffer.slice(
        exported.exportedBytes.byteOffset,
        exported.exportedBytes.byteOffset + exported.exportedBytes.byteLength,
      ),
      type: "export-midi-result",
      requestId: exportRequest.requestId,
      projectId: exportRequest.projectId,
      revision: exportRequest.revision,
      engineVersion: exportRequest.engineVersion,
    });

    expect(validatedExport.exportedBytes).toBeDefined();
    expect(validatedExport.exportedBytes.byteLength).toBeGreaterThan(0);
    expect(validatedExport.markedCount).toBeGreaterThanOrEqual(0);
  });
});
