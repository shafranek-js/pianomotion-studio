import type { PerformancePlan, SongDocument, M1KeyStyle } from "@handthesia/contracts";
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
  includeAudio: boolean;
  audioSource: "synth" | "recording" | "none";
  tailSeconds?: number; // default 1.5s VIDEO_TAIL_S
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
  outputFilename?: string | null;
  audioWavBlob?: Blob | null;
  outputMimeType?: string | null;
}

export interface ExportSceneDataSource {
  document: SongDocument;
  performancePlan: PerformancePlan;
  keyStyle: M1KeyStyle;
  profile: PianistProfile;
  settings: AppSettings;
  audioRecording?: DecodedAudioRecording | null;
  audioOffset?: number;
}
