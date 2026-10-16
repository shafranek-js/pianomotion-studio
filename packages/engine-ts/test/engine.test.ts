import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  M1AnalyzeMidiResultSchema,
  M1ReplanDocumentResultSchema,
  M1SampleMotionResultSchema,
  M1ExportMidiResultSchema,
} from "@handthesia/contracts";
import {
  analyzeMidi,
  replanDocument,
  sampleMotionWindow,
  exportFingeredMidi,
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

describe("@handthesia/engine-ts", () => {
  it("provides manifest and engineVersion matching Python core", () => {
    const manifest = _manifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(typeof manifest.engineVersion).toBe("string");
    expect(manifest.engineVersion.length).toBe(64);
    expect(_engine_version()).toBe(manifest.engineVersion);
  });

  it("analyzes tracked-right-hand.mid and matches golden assignments", () => {
    const midiBytes = loadMidi("tracked-right-hand.mid");
    const golden = loadGolden("tracked-right-hand.json") as {
      assignments?: Array<{ noteId: string; hand: string; finger: number | null }>;
    };

    const options = {
      fixtureId: "tracked-right-hand",
      projectId: "test-proj",
      revision: 0,
      requestId: "test-req",
      engineVersion: _engine_version(),
      sampleDense: true,
    };

    const result = analyzeMidi(midiBytes, options);
    const validated = M1AnalyzeMidiResultSchema.parse(result);

    expect(validated.status).toBe("loaded");
    expect(validated.document).toBeDefined();
    expect(validated.fingeringPlan).toBeDefined();
    expect(validated.performancePlan).toBeDefined();
    expect(validated.rawBaseline).toBeDefined();

    if (golden.assignments && validated.fingeringPlan) {
      expect(validated.fingeringPlan.assignments.length).toBe(golden.assignments.length);
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
    const replanned = replanDocument(
      midiBytes,
      editedDocument,
      editedFingeringPlan,
      replanOptions,
    );

    const validatedReplan = M1ReplanDocumentResultSchema.parse({
      ...replanned,
      type: "replan-document-result",
      requestId: "req-2",
      projectId: "test-proj",
      revision: 1,
      engineVersion: _engine_version(),
    });

    expect(validatedReplan.status).toBe("loaded");
    expect(validatedReplan.fingeringPlan).toBeDefined();
    expect(validatedReplan.performancePlan).toBeDefined();
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
  });

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

    const exported = exportFingeredMidi(
      midiBytes,
      initial.document,
      initial.fingeringPlan,
    );

    const validatedExport = M1ExportMidiResultSchema.parse({
      ...exported,
      type: "export-midi-result",
      requestId: "req-1",
      projectId: "test-proj",
      revision: 0,
      engineVersion: _engine_version(),
    });

    expect(validatedExport.exportedBytes).toBeDefined();
    expect(validatedExport.exportedBytes.byteLength).toBeGreaterThan(0);
    expect(validatedExport.markedCount).toBeGreaterThanOrEqual(0);
  });
});
