import { describe, expect, it } from "vitest";
import {
  PACKAGE_VERSION,
  PracticeStateSchema,
  ProjectPackageSchema,
  ResourceDescriptorSchema,
  SongDocumentSchema,
  validatePracticeStateForProject,
} from "./index";

const sourceHash = "a".repeat(64);
const document = SongDocumentSchema.parse({
  schemaVersion: 1,
  projectId: "project-practice",
  revision: 3,
  title: "Practice fixture",
  durationSeconds: 4,
  sourceMidiResourceId: "source-midi",
  tracks: [],
  notes: [],
  tempoMap: [],
  pedalControls: [],
});
const sourceResource = ResourceDescriptorSchema.parse({
  resourceId: "source-midi",
  purpose: "source-midi",
  mediaType: "audio/midi",
  byteLength: 1,
  sha256: sourceHash,
  path: "resources/source.mid",
});

const practiceState = {
  schemaVersion: 1 as const,
  sourceMidiSha256: sourceHash,
  loop: { startSeconds: 1.1, endSeconds: 1.2, enabled: true },
  bookmarks: [
    { id: "bookmark-1", name: "Return", timeSeconds: 2 },
    { id: "bookmark-2", name: "Return", timeSeconds: 3 },
  ],
};

describe("practice state contracts", () => {
  it("accepts the decimal minimum loop span and repeated bookmark names", () => {
    expect(PracticeStateSchema.parse(practiceState).bookmarks).toHaveLength(2);
    expect(validatePracticeStateForProject(practiceState, document, sourceResource)).toEqual(practiceState);
  });

  it("rejects loop spans below the minimum, duplicate bookmark IDs, and out-of-range times", () => {
    expect(PracticeStateSchema.safeParse({
      ...practiceState,
      loop: { startSeconds: 1.1, endSeconds: 1.199, enabled: true },
    }).success).toBe(false);
    expect(PracticeStateSchema.safeParse({
      ...practiceState,
      bookmarks: [practiceState.bookmarks[0], { ...practiceState.bookmarks[1], id: "bookmark-1" }],
    }).success).toBe(false);
    expect(() => validatePracticeStateForProject({
      ...practiceState,
      loop: { startSeconds: 3.9, endSeconds: 4.1, enabled: false },
    }, document, sourceResource)).toThrow(/song duration/i);
    expect(() => validatePracticeStateForProject({
      ...practiceState,
      bookmarks: [{ id: "late", name: "Too late", timeSeconds: 4.01 }],
    }, document, sourceResource)).toThrow(/song duration/i);
  });

  it("requires the exact source hash and source resource ID", () => {
    expect(() => validatePracticeStateForProject({
      ...practiceState,
      sourceMidiSha256: "b".repeat(64),
    }, document, sourceResource)).toThrow(/SHA-256/i);
    expect(() => validatePracticeStateForProject(practiceState, document, {
      ...sourceResource,
      resourceId: "other-source",
    })).toThrow(/resource ID/i);
  });

  it("accepts legacy packages without optional practice metadata", () => {
    const legacyPackage = ProjectPackageSchema.parse({
      packageVersion: PACKAGE_VERSION,
      projectId: document.projectId,
      sourceContext: { fixtureId: "fixture-practice", keyStyle: "realistic" },
      document: { ...document, sourceMidiResourceId: undefined },
      profiles: [],
      resources: [],
    });
    expect(legacyPackage.practiceState).toBeUndefined();
  });
});
