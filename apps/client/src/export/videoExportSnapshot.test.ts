import { describe, expect, it } from "vitest";
import type { FingeringPlan, M1RawBaseline, PerformancePlan, ResourceDescriptor, SongDocument } from "@handthesia/contracts";
import { DEFAULT_PROFILE } from "../profiles";
import { getSettings } from "../settings";
import { freezeVideoExportSnapshot } from "./videoExportSnapshot";
import type { ExportSceneDataSource, ExportSourceIdentity, VideoExportOptions } from "./types";

const engineVersion = "a".repeat(64);
const exportOptions: VideoExportOptions = {
  preset: "720p", width: 1280, height: 720, fps: 30, speed: 1,
  format: "webm", includeAudio: true, audioSource: "soundfont",
};

function makeSource(soundFontAssetBlob?: Blob, soundFontAssetBytes?: ArrayBuffer): ExportSceneDataSource {
  const midiBytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const document: SongDocument = {
    schemaVersion: 1, projectId: "snapshot-project", revision: 4, title: "Frozen",
    durationSeconds: 1, sourceMidiResourceId: "source-midi",
    tracks: [{ trackId: "track-1", instrumentIndex: 0, name: "Piano", program: 0, hand: null }],
    notes: [], tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500_000, eventOrdinal: 0 }], pedalControls: [],
  };
  const fingeringPlan: FingeringPlan = {
    schemaVersion: 1, kind: "fingering", planId: "fingering-1", projectId: document.projectId,
    inputRevision: document.revision, profileId: DEFAULT_PROFILE.profileId, profileRevision: DEFAULT_PROFILE.revision,
    engineVersion, assignments: [], diagnostics: [],
  };
  const performancePlan: PerformancePlan = {
    schemaVersion: 1, kind: "performance", planId: "performance-1", projectId: document.projectId,
    inputRevision: document.revision, profileId: DEFAULT_PROFILE.profileId, profileRevision: DEFAULT_PROFILE.revision,
    engineVersion, fingeringPlanId: fingeringPlan.planId, diagnostics: [], events: [],
  };
  const resource: ResourceDescriptor = {
    resourceId: "source-midi", purpose: "source-midi", mediaType: "audio/midi", path: "resources/source.mid",
    byteLength: midiBytes.byteLength, sha256: "b".repeat(64),
  };
  const sourceIdentity: ExportSourceIdentity = {
    projectId: document.projectId, revision: document.revision, engineVersion, originalMidiBytes: midiBytes,
    fingeringPlan, rawBaseline: { inputSha256: resource.sha256 } as M1RawBaseline,
    sourceContext: { fixtureId: "tracked-right-hand", keyStyle: "realistic" }, resource,
    activeOutputId: "soundfont", soundFontAssetId: "c".repeat(64),
    soundFontAssetBlob: soundFontAssetBlob ?? null, soundFontAssetBytes: soundFontAssetBytes ?? null,
  };
  return {
    sourceIdentity, document, performancePlan, keyStyle: "realistic", profile: DEFAULT_PROFILE,
    settings: getSettings(),
  };
}

describe("freezeVideoExportSnapshot SoundFont retention", () => {
  it("freezes the selected 3D camera independently of later live view changes", () => {
    const source = makeSource();
    source.sceneView = { dimension: "3d", cameraPreset: "side_arch" };
    const snapshot = freezeVideoExportSnapshot(source, exportOptions);
    source.sceneView.cameraPreset = "concert";
    source.sceneView.dimension = "2d";
    expect(snapshot.sceneView).toEqual({ dimension: "3d", cameraPreset: "side_arch" });
    expect(freezeVideoExportSnapshot(makeSource(), exportOptions).sceneView.dimension).toBe("2d");
  });
  it("retains the immutable large-bank Blob by reference without copying it into bytes", async () => {
    const bytes = new Uint8Array([8, 9, 10, 11]);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "audio/sf2" });
    const source = makeSource(blob);
    const snapshot = freezeVideoExportSnapshot(source, exportOptions);

    expect(snapshot.sourceIdentity.soundFontAssetBlob).toBe(blob);
    expect(snapshot.sourceIdentity.soundFontAssetBytes).toBeNull();
    expect(snapshot.sourceIdentity.soundFontAssetBlob?.size).toBe(blob.size);
    expect([...new Uint8Array(await snapshot.sourceIdentity.soundFontAssetBlob!.arrayBuffer())]).toEqual([8, 9, 10, 11]);
    expect(snapshot.sourceIdentity.originalMidiBytes).not.toBe(source.sourceIdentity!.originalMidiBytes);

    // Switching or deleting the active app bank changes the live identity, not
    // the Blob already frozen into this export.
    source.sourceIdentity!.soundFontAssetBlob = new Blob([new Uint8Array([99]).buffer], { type: "audio/sf2" });
    source.sourceIdentity!.soundFontAssetId = "d".repeat(64);
    source.sourceIdentity!.activeOutputId = "webmidi";
    expect(snapshot.sourceIdentity.soundFontAssetBlob).toBe(blob);
    expect(snapshot.sourceIdentity.soundFontAssetId).toBe("c".repeat(64));
    expect(snapshot.sourceIdentity.activeOutputId).toBe("soundfont");
  });

  it("keeps the legacy ArrayBuffer adapter isolated from later mutations", () => {
    const bytes = new Uint8Array([3, 4, 5]);
    const source = makeSource(undefined, bytes.buffer);
    const snapshot = freezeVideoExportSnapshot(source, exportOptions);
    bytes[0] = 99;

    expect(snapshot.sourceIdentity.soundFontAssetBlob).toBeNull();
    expect([...new Uint8Array(snapshot.sourceIdentity.soundFontAssetBytes!)]).toEqual([3, 4, 5]);
  });
});
