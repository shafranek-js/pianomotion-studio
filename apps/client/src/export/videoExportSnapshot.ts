import type { ExportSceneDataSource, ExportSourceIdentity, VideoExportOptions } from "./types";
import type { DecodedAudioRecording } from "../audio";

export interface FrozenVideoExportSnapshot {
  sceneView: NonNullable<ExportSceneDataSource["sceneView"]>;
  sourceIdentity: ExportSourceIdentity;
  document: ExportSceneDataSource["document"];
  performancePlan: ExportSceneDataSource["performancePlan"];
  motionPlan: ExportSceneDataSource["motionPlan"];
  keyStyle: ExportSceneDataSource["keyStyle"];
  profile: ExportSceneDataSource["profile"];
  settings: ExportSceneDataSource["settings"];
  audioRecording: DecodedAudioRecording | null;
  audioOffset: number;
  options: VideoExportOptions;
}

function cloneDto<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRecording(recording: DecodedAudioRecording | null | undefined): DecodedAudioRecording | null {
  if (!recording) return null;
  const original = recording.buffer;
  const channels = Array.from({ length: original.numberOfChannels }, (_, index) => original.getChannelData(index).slice());
  const copiedBuffer = {
    numberOfChannels: original.numberOfChannels,
    sampleRate: original.sampleRate,
    length: original.length,
    duration: original.duration,
    getChannelData(channel: number) {
      const data = channels[channel];
      if (!data) throw new RangeError(`Recording channel ${channel} does not exist.`);
      return data;
    },
  } as AudioBuffer;
  return {
    ...recording,
    buffer: copiedBuffer,
    peaks: recording.peaks.slice(),
  };
}

function validateIdentity(source: ExportSceneDataSource, identity: ExportSourceIdentity): void {
  const { document, profile, performancePlan, keyStyle } = source;
  if (!identity.projectId.trim() || identity.revision < 0 || !Number.isInteger(identity.revision)) {
    throw new Error("Video export source identity is incomplete.");
  }
  if (document.projectId !== identity.projectId || document.revision !== identity.revision) {
    throw new Error("Video export document does not match its saved project revision.");
  }
  if (!/^[a-f0-9]{64}$/.test(identity.engineVersion) ||
      identity.fingeringPlan.engineVersion !== identity.engineVersion ||
      identity.fingeringPlan.projectId !== identity.projectId ||
      identity.fingeringPlan.inputRevision !== identity.revision ||
      identity.fingeringPlan.profileId !== profile.profileId ||
      identity.fingeringPlan.profileRevision !== profile.revision) {
    throw new Error("Video export fingering intent does not match its source identity and selected profile.");
  }
  if (performancePlan.projectId !== identity.projectId ||
      performancePlan.inputRevision !== identity.revision ||
      performancePlan.engineVersion !== identity.engineVersion ||
      performancePlan.profileId !== profile.profileId ||
      performancePlan.profileRevision !== profile.revision ||
      performancePlan.fingeringPlanId !== identity.fingeringPlan.planId) {
    throw new Error("Video export performance plan is stale or belongs to a different source identity.");
  }
  if (identity.resource.purpose !== "source-midi" || identity.resource.mediaType !== "audio/midi" ||
      identity.resource.path !== "resources/source.mid" ||
      identity.resource.byteLength !== identity.originalMidiBytes.byteLength ||
      identity.rawBaseline.inputSha256 !== identity.resource.sha256 ||
      document.sourceMidiResourceId !== identity.resource.resourceId) {
    throw new Error("Video export source resource does not match the frozen original MIDI.");
  }
  if (identity.sourceContext.keyStyle !== keyStyle) {
    throw new Error("Video export keyboard style does not match the source context.");
  }
}

/**
 * Synchronously captures every live export input before the caller performs an await.
 * Mutable DTOs, MIDI bytes, and recording channels are copied. The immutable SoundFont Blob is retained
 * by reference, so a large bank is not duplicated and later asset-store changes cannot affect this export.
 */
export function freezeVideoExportSnapshot(
  source: ExportSceneDataSource,
  options: VideoExportOptions,
): FrozenVideoExportSnapshot {
  if (!source.sourceIdentity) {
    throw new Error("Video export requires a complete saved source identity.");
  }
  const identity = source.sourceIdentity;
  validateIdentity(source, identity);
  const copiedIdentity: ExportSourceIdentity = {
    ...cloneDto({
      projectId: identity.projectId,
      revision: identity.revision,
      engineVersion: identity.engineVersion,
      fingeringPlan: identity.fingeringPlan,
      rawBaseline: identity.rawBaseline,
      sourceContext: identity.sourceContext,
      resource: identity.resource,
      activeOutputId: identity.activeOutputId,
      soundFontAssetId: identity.soundFontAssetId,
    }),
    originalMidiBytes: identity.originalMidiBytes.slice(0),
    soundFontAssetBlob: identity.soundFontAssetBlob ?? null,
    // Compatibility only: production passes a Blob. Legacy test/adapters still get a frozen byte copy.
    soundFontAssetBytes: identity.soundFontAssetBlob
      ? null
      : identity.soundFontAssetBytes?.slice(0) ?? null,
  };
  return {
    sceneView: source.sceneView ? { ...source.sceneView } : { dimension: "2d", cameraPreset: "concert" },
    sourceIdentity: copiedIdentity,
    document: cloneDto(source.document),
    performancePlan: cloneDto(source.performancePlan),
    motionPlan: source.motionPlan ? cloneDto(source.motionPlan) : null,
    keyStyle: source.keyStyle,
    profile: cloneDto(source.profile),
    settings: cloneDto(source.settings),
    audioRecording: cloneRecording(source.audioRecording),
    audioOffset: Number.isFinite(source.audioOffset) ? source.audioOffset! : 0,
    options: { ...options },
  };
}
