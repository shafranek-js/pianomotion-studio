import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { M1ExportMidiRequestSchema, type FingeringAssignment } from "@handthesia/contracts";
import { analyzeMidi, _engine_version } from "../src/index.ts";

const fixturesDir = resolve(__dirname, "../../../tests/fixtures");
const midiBytes = new Uint8Array(readFileSync(resolve(fixturesDir, "midi", "tracked-right-hand.mid")));
const analysis = analyzeMidi(midiBytes, {
  fixtureId: "tracked-right-hand",
  projectId: "test-proj",
  revision: 0,
  requestId: "analysis-request",
  engineVersion: _engine_version(),
  sampleDense: true,
});
const document = analysis.document;
const fingeringPlan = analysis.fingeringPlan;

function request(overrides: Record<string, unknown> = {}) {
  return {
    type: "export-midi",
    requestId: "export-request",
    projectId: "test-proj",
    revision: 0,
    engineVersion: _engine_version(),
    midiBytes: midiBytes.buffer.slice(midiBytes.byteOffset, midiBytes.byteOffset + midiBytes.byteLength),
    document,
    fingeringPlan,
    ...overrides,
  };
}

function issuesFor(input: unknown) {
  const result = M1ExportMidiRequestSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues;
}

describe("M1ExportMidiRequest semantic validation", () => {
  it("accepts the analyzed document and its earlier plan even though planId differs from requestId", () => {
    const result = M1ExportMidiRequestSchema.safeParse(request());
    expect(result.success).toBe(true);
    expect(fingeringPlan.planId).not.toBe("export-request");
  });

  it("rejects a document from another project or revision", () => {
    expect(issuesFor(request({ document: { ...document, projectId: "other-proj" } })))
      .toContainEqual(expect.objectContaining({ path: ["document", "projectId"], message: "must match the request projectId" }));
    expect(issuesFor(request({ document: { ...document, revision: 3 } })))
      .toContainEqual(expect.objectContaining({ path: ["document", "revision"], message: "must match the request revision" }));
  });

  it("rejects a plan from another project, revision or engine version", () => {
    expect(issuesFor(request({ fingeringPlan: { ...fingeringPlan, projectId: "other-proj" } })))
      .toContainEqual(expect.objectContaining({ path: ["fingeringPlan", "projectId"] }));
    expect(issuesFor(request({ fingeringPlan: { ...fingeringPlan, inputRevision: 2 } })))
      .toContainEqual(expect.objectContaining({ path: ["fingeringPlan", "inputRevision"] }));
    expect(issuesFor(request({ fingeringPlan: { ...fingeringPlan, engineVersion: "0".repeat(64) } })))
      .toContainEqual(expect.objectContaining({ path: ["fingeringPlan", "engineVersion"] }));
  });

  it("rejects an unknown assignment noteId with its assignment index", () => {
    const assignments = fingeringPlan.assignments.map((assignment: FingeringAssignment, index: number) =>
      index === 0 ? { ...assignment, noteId: "missing-note" } : assignment);
    const issues = issuesFor(request({ fingeringPlan: { ...fingeringPlan, assignments } }));
    expect(issues).toContainEqual(expect.objectContaining({
      path: ["fingeringPlan", "assignments", 0, "noteId"],
      message: "unknown noteId",
    }));
  });

  it("rejects a missing assignment for a document note", () => {
    const missing = document.notes[0]!;
    const assignments = fingeringPlan.assignments.filter((assignment: FingeringAssignment) => assignment.noteId !== missing.noteId);
    const issues = issuesFor(request({ fingeringPlan: { ...fingeringPlan, assignments } }));
    expect(issues).toContainEqual(expect.objectContaining({
      path: ["fingeringPlan", "assignments"],
      message: `missing disposition for note ${missing.noteId}`,
    }));
  });

  it("rejects duplicate assignments and a hand that disagrees with the document", () => {
    const duplicate = [fingeringPlan.assignments[0]!, ...fingeringPlan.assignments];
    const duplicateIssues = issuesFor(request({ fingeringPlan: { ...fingeringPlan, assignments: duplicate } }));
    expect(duplicateIssues.some((issue) => /duplicate assignments reference/.test(issue.message))).toBe(true);

    const assignments = fingeringPlan.assignments.map((assignment: FingeringAssignment, index: number) =>
      index === 0 ? { ...assignment, hand: assignment.hand === "left" ? "right" : "left" } : assignment);
    const issues = issuesFor(request({ fingeringPlan: { ...fingeringPlan, assignments } }));
    expect(issues).toContainEqual(expect.objectContaining({
      path: ["fingeringPlan", "assignments", 0, "hand"],
      message: "must match the normalized source note hand",
    }));
  });
});
