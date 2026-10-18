import { describe, expect, it } from "vitest";
import type { PracticeState, ResourceDescriptor, SongDocument } from "@handthesia/contracts";
import { computeSha256Hex, buildProjectPackage, exportProjectPackageJson, parseProjectPackageJson, projectPackageToSavedProject, validateProjectPackage } from "./packageExporter";
import { validateSavedProject, type SavedProject } from "./projectDb";
import { assessSessionSnapshot, saveSessionSnapshot } from "./autosave";

const rawMidiBytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]).buffer;

async function makeProject(): Promise<{ project: SavedProject; source: ResourceDescriptor; practiceState: PracticeState }> {
  const projectId = "practice-persistence";
  const source: ResourceDescriptor = {
    resourceId: "practice-source-midi",
    purpose: "source-midi",
    mediaType: "audio/midi",
    byteLength: rawMidiBytes.byteLength,
    sha256: await computeSha256Hex(rawMidiBytes),
    path: "resources/source.mid",
  };
  const document: SongDocument = {
    schemaVersion: 1,
    projectId,
    revision: 0,
    title: "Practice persistence fixture",
    durationSeconds: 8,
    sourceMidiResourceId: source.resourceId,
    tracks: [],
    notes: [],
    tempoMap: [],
    pedalControls: [],
  };
  const practiceState: PracticeState = {
    schemaVersion: 1,
    sourceMidiSha256: source.sha256,
    loop: { startSeconds: 1.1, endSeconds: 1.2, enabled: true },
    bookmarks: [{ id: "bookmark-start", name: "Start", timeSeconds: 2 }],
  };
  return {
    source,
    practiceState,
    project: {
      projectId,
      name: "Practice persistence fixture",
      updatedAt: 1,
      document,
      rawMidiBytes,
      resources: [source],
      sourceContext: { fixtureId: "practice-persistence", keyStyle: "realistic" },
      practiceState,
    },
  };
}

describe("project practice-state persistence", () => {
  it("round-trips practice state through project validation and package JSON", async () => {
    const { project, source, practiceState } = await makeProject();
    const checked = validateSavedProject(project);
    const pkg = await buildProjectPackage(checked);
    const restored = projectPackageToSavedProject(parseProjectPackageJson(await exportProjectPackageJson(checked)));

    expect(checked.practiceState).toEqual(practiceState);
    expect(pkg.practiceState).toEqual(practiceState);
    expect(restored.practiceState).toEqual(practiceState);
    expect(restored.resources).toEqual([source]);
  });

  it("rejects state with a mismatched source hash or out-of-duration marker", async () => {
    const { project, practiceState } = await makeProject();
    expect(() => validateSavedProject({
      ...project,
      practiceState: { ...practiceState, sourceMidiSha256: "b".repeat(64) },
    })).toThrow(/SHA-256/i);
    expect(() => validateSavedProject({
      ...project,
      practiceState: {
        ...practiceState,
        bookmarks: [{ id: "late", name: "Late", timeSeconds: 8.1 }],
      },
    })).toThrow(/song duration/i);

    const pkg = await buildProjectPackage(project);
    expect(() => validateProjectPackage({
      ...pkg,
      practiceState: { ...practiceState, sourceMidiSha256: "b".repeat(64) },
    })).toThrow(/SHA-256/i);
  });

  it("accepts legacy saved projects and packages without optional practice state", async () => {
    const { project } = await makeProject();
    const legacyProject = { ...project };
    delete legacyProject.practiceState;
    expect(validateSavedProject(legacyProject).practiceState).toBeUndefined();

    const pkg = await buildProjectPackage(project);
    const legacyPackage = { ...pkg };
    delete legacyPackage.practiceState;
    expect(validateProjectPackage(legacyPackage).practiceState).toBeUndefined();
  });

  it("reports invalid recovery practice metadata as corrupt and rejects writes", async () => {
    const { project, source, practiceState } = await makeProject();
    const badPracticeState = { ...practiceState, sourceMidiSha256: "b".repeat(64) };
    const snapshot = {
      projectId: project.projectId,
      updatedAt: 1,
      document: project.document,
      rawMidiBytes,
      sourceDescriptor: source,
      practiceState: badPracticeState,
    };

    await expect(saveSessionSnapshot(snapshot)).rejects.toThrow(/SHA-256/i);
    await expect(assessSessionSnapshot(snapshot, "engine-current")).resolves.toMatchObject({ status: "corrupt" });
  });
});
