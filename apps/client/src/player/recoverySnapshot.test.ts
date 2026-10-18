import { describe, expect, it } from "vitest";
import type { FingeringPlan, M1AnalyzeMidiResult, PianistProfile, PracticeState, SongDocument } from "@handthesia/contracts";
import { buildRecoverySnapshot } from "./recoverySnapshot";

describe("buildRecoverySnapshot", () => {
  it("preserves project identity, manual intent, and the complete named scene state", () => {
    const result = { projectId: "project-1", resource: { resourceId: "midi-1" } } as M1AnalyzeMidiResult;
    const document = { projectId: "project-1", revision: 4 } as SongDocument;
    const draftFingeringPlan = { projectId: "project-1", inputRevision: 4, assignments: [{ noteId: "note-1", finger: 5 }] } as FingeringPlan;
    const profile = { profileId: "profile-1" } as PianistProfile;
    const rawMidiBytes = new ArrayBuffer(8);
    const practiceState: PracticeState = {
      schemaVersion: 1,
      sourceMidiSha256: "a".repeat(64),
      loop: null,
      bookmarks: [{ id: "bookmark-1", name: "Phrase start", timeSeconds: 1.5 }],
    };

    const snapshot = buildRecoverySnapshot({
      projectName: "Imported Etude.mid",
      updatedAt: 123,
      document,
      draftFingeringPlan,
      result,
      rawMidiBytes,
      profile,
      keyStyle: "realistic",
      sourceContext: { fixtureId: "imported-midi", keyStyle: "realistic" },
      viewMode: "editor",
      sceneView: { dimension: "3d", cameraPreset: "overhead" },
      plansState: "valid",
      practiceState,
    });

    expect(snapshot).toMatchObject({
      projectId: "project-1",
      projectName: "Imported Etude.mid",
      updatedAt: 123,
      document,
      fingeringPlan: draftFingeringPlan,
      draftFingeringPlan,
      result,
      rawMidiBytes,
      activeProfileId: "profile-1",
      profile,
      viewMode: "editor",
      sceneView: { dimension: "3d", cameraPreset: "overhead" },
      sourceDescriptor: result.resource,
      practiceState,
    });
  });
});
