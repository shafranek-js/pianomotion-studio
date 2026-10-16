import type { PerformancePlan, SongDocument, M1KeyStyle, MotionPlan, FingeringPlan, M1RawBaseline, ProjectSourceContext, ResourceDescriptor } from "@handthesia/contracts";
import type { DecodedAudioRecording } from "../audio";
import type { AppSettings } from "../settings";
import type { PianistProfile } from "../profiles";

export type ExportResolutionPreset = "1080p" | "720p" | "4k" | "window";

export interface VideoExportDimensions {
  width: number;
  height: number;
  label: string;
}

export interface VideoExportOptions {
  preset: ExportResolutionPreset;
  width: number;
  height: number;
  fps: 30 | 60;
  speed: number;
  format?: "mp4" | "webm";
  includeAudio: boolean;
  audioSource: "synth" | "soundfont" | "recording" | "none";
  tailSeconds?: number; // default 1.5s VIDEO_TAIL_S
  /** Tests may force the bounded in-memory output. Normal exports use a save-file stream when available. */
  outputMode?: "auto" | "file" | "bounded-blob";
  /** Override the normal 128 MiB Blob cap for focused unit tests only. */
  blobLimitBytes?: number;
}

export type ExportPhase =
  | "idle"
  | "preparing"
  | "rendering_frames"
  | "rendering_audio"
  | "multiplexing"
  | "completed"
  | "cancelled"
  | "error";

export interface VideoExportProgress {
  phase: ExportPhase;
  doneFrames: number;
  totalFrames: number;
  frameProgress: number; // 0.0 .. 1.0
  audioProgress: number; // 0.0 .. 1.0
  muxProgress: number; // 0.0 .. 1.0
  overallProgress: number; // 0.0 .. 1.0
  statusText: string;
  etaSeconds: number | null;
  previewCanvas?: HTMLCanvasElement | null;
  error?: string | null;
  outputBlob?: Blob | null;
  outputSavedFile?: { name: string; sizeBytes: number; mimeType: string } | null;
  outputFilename?: string | null;
  audioWavBlob?: Blob | null;
  outputMimeType?: string | null;
}

export interface ExportSceneDataSource {
  /** Required by the production exporter; optional only for legacy view/test callers. */
  sourceIdentity?: ExportSourceIdentity;
  document: SongDocument;
  performancePlan: PerformancePlan;
  motionPlan?: MotionPlan | null;
  keyStyle: M1KeyStyle;
  profile: PianistProfile;
  settings: AppSettings;
  audioRecording?: DecodedAudioRecording | null;
  audioOffset?: number;
}

export interface ExportSourceIdentity {
  projectId: string;
  revision: number;
  engineVersion: string;
  originalMidiBytes: ArrayBuffer;
  fingeringPlan: FingeringPlan;
  rawBaseline: M1RawBaseline;
  sourceContext: ProjectSourceContext;
  resource: ResourceDescriptor;
  activeOutputId: "synth" | "soundfont" | "webmidi";
  soundFontAssetId: string | null;
  /** Immutable loaded SF2 file retained by reference for this export; never written to a project package. */
  soundFontAssetBlob?: Blob | null;
  /** @deprecated Compatibility for tests and legacy adapters. Production exports use the immutable Blob above. */
  soundFontAssetBytes?: ArrayBuffer | null;
}
