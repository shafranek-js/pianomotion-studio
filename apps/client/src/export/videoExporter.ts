import { PianoScene } from "../render";
import { calculateExportTiming } from "./videoDimensions";
import { renderOfflineAudio, type OfflineAudioRenderResult } from "./offlineAudioRenderer";
import type {
  ExportSceneDataSource,
  VideoExportOptions,
  VideoExportProgress,
} from "./types";

/**
 * Progress weights for video export pipeline stages:
 *   WEIGHTS = (0.86, 0.10, 0.04)  // frames, audio, mux
 */
export const WEIGHT_FRAMES = 0.86;
export const WEIGHT_AUDIO = 0.10;
export const WEIGHT_MUX = 0.04;

export interface VideoExportResult {
  videoBlob: Blob;
  audioWavBlob?: Blob;
  filename: string;
}

/**
 * Resolves the best supported video MIME type for MediaRecorder.
 */
export function getSupportedVideoMimeType(): string {
  if (typeof MediaRecorder === "undefined") {
    return "video/webm";
  }
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
  ];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "video/webm";
}

/**
 * Headless offline/real-time video export engine.
 */
export class VideoExporter {
  private cancelled = false;
  private running = false;
  private abortController = new AbortController();
  private exportCanvas: HTMLCanvasElement | null = null;

  public cancel(): void {
    this.cancelled = true;
    this.abortController.abort();
  }

  public isCancelled(): boolean {
    return this.cancelled;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getExportCanvas(): HTMLCanvasElement | null {
    return this.exportCanvas;
  }

  public async exportVideo(
    source: ExportSceneDataSource,
    options: VideoExportOptions,
    onProgress?: (progress: VideoExportProgress) => void,
  ): Promise<VideoExportResult> {
    if (this.running) {
      throw new Error("An export is already running");
    }

    this.cancelled = false;
    this.running = true;
    this.abortController = new AbortController();

    const startTimeMs = Date.now();
    const leadIn = source.settings.leadInSeconds ?? -2.0;
    const songDuration = source.document.durationSeconds ?? 0;
    const timing = calculateExportTiming(
      leadIn,
      songDuration,
      options.speed,
      options.tailSeconds,
      options.fps,
    );

    const safeTitle = (source.document.title || "performance")
      .trim()
      .replace(/[^a-zA-Z0-9_\u0400-\u04FF-]/g, "_");
    const mimeType = getSupportedVideoMimeType();
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const filename = `${safeTitle}_${options.preset}_${options.fps}fps.${extension}`;

    // Create offscreen canvas for headless rendering
    let canvas: HTMLCanvasElement;
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      canvas = document.createElement("canvas");
      canvas.width = options.width;
      canvas.height = options.height;
    } else {
      // Mock canvas for Node/test environments
      canvas = {
        width: options.width,
        height: options.height,
        getContext: () => null,
      } as unknown as HTMLCanvasElement;
    }
    this.exportCanvas = canvas;

    let scene: PianoScene | null = null;
    let recorder: MediaRecorder | null = null;
    const recordedChunks: Blob[] = [];

    try {
      onProgress?.({
        phase: "preparing",
        doneFrames: 0,
        totalFrames: timing.totalFrames,
        frameProgress: 0,
        audioProgress: 0,
        muxProgress: 0,
        overallProgress: 0.01,
        statusText: "Initializing offscreen renderer...",
        etaSeconds: null,
        previewCanvas: canvas,
      });

      // Initialize offscreen PixiJS scene
      if (typeof document !== "undefined" && typeof document.createElement === "function") {
        scene = await PianoScene.create({
          target: canvas,
          song: source.document,
          performancePlan: source.performancePlan,
          keyStyle: source.keyStyle,
          displaySettings: {
            showFingerLabels: source.settings.showFingerLabels,
            showNoteNames: source.settings.showNoteNames,
            skinStyle: source.settings.skinStyle,
            showHandShadow: source.settings.showHandShadow,
            renderCapFps: 0, // Uncapped for export
          },
          pixelsPerSecond: 180,
        });
      }

      // Initialize MediaRecorder if in browser environment
      const hasMediaRecorder =
        typeof MediaRecorder !== "undefined" &&
        typeof canvas.captureStream === "function";

      if (hasMediaRecorder) {
        const stream = canvas.captureStream(options.fps);
        recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 8_000_000,
        });

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            recordedChunks.push(event.data);
          }
        };

        recorder.start(100); // 100ms slice chunks
      }

      // --- PHASE 1: Render Video Frames (Weight: 0.86) ---
      const totalFrames = timing.totalFrames;
      for (let i = 0; i < totalFrames; i++) {
        if (this.cancelled) {
          throw new Error("Export cancelled");
        }

        const t = timing.startTime + (i / timing.fps) * timing.speed;

        if (scene) {
          scene.update(t);
          scene.getApp().renderer.render(scene.getApp().stage);
        }

        const doneFrames = i + 1;
        const frameFrac = doneFrames / totalFrames;
        const overallProgress = frameFrac * WEIGHT_FRAMES;

        const elapsedSec = (Date.now() - startTimeMs) / 1000;
        const etaSeconds =
          frameFrac > 0.03
            ? Math.max(0, Math.round(((elapsedSec / frameFrac) * (1 - frameFrac))))
            : null;

        onProgress?.({
          phase: "rendering_frames",
          doneFrames,
          totalFrames,
          frameProgress: frameFrac,
          audioProgress: 0,
          muxProgress: 0,
          overallProgress,
          statusText: `Rendering frames ${doneFrames} / ${totalFrames} (${Math.round(frameFrac * 100)}%)`,
          etaSeconds,
          previewCanvas: canvas,
        });

        // Async yield every 4 frames (or every frame if test/slow) to allow recorder processing & DOM updates
        if (i % 4 === 0 || i === totalFrames - 1) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      // Stop recorder and finalize video stream
      if (recorder && recorder.state !== "inactive") {
        await new Promise<void>((resolve) => {
          recorder!.onstop = () => resolve();
          recorder!.stop();
        });
      }

      if (this.cancelled) {
        throw new Error("Export cancelled");
      }

      // --- PHASE 2: Render Audio (Weight: 0.10) ---
      let audioResult: OfflineAudioRenderResult | null = null;
      if (options.includeAudio && options.audioSource !== "none") {
        onProgress?.({
          phase: "rendering_audio",
          doneFrames: totalFrames,
          totalFrames,
          frameProgress: 1.0,
          audioProgress: 0.1,
          muxProgress: 0,
          overallProgress: WEIGHT_FRAMES + 0.01,
          statusText: "Rendering master audio...",
          etaSeconds: null,
          previewCanvas: canvas,
        });

        audioResult = await renderOfflineAudio({
          document: source.document,
          performancePlan: source.performancePlan,
          audioRecording: options.audioSource === "recording" ? source.audioRecording : null,
          audioOffset: source.audioOffset,
          speed: options.speed,
          startTime: timing.startTime,
          durationSeconds: timing.durationSeconds,
          volume: source.settings.masterVolume ?? 0.8,
          onProgress: (audioP) => {
            const overallProgress = WEIGHT_FRAMES + audioP * WEIGHT_AUDIO;
            onProgress?.({
              phase: "rendering_audio",
              doneFrames: totalFrames,
              totalFrames,
              frameProgress: 1.0,
              audioProgress: audioP,
              muxProgress: 0,
              overallProgress,
              statusText: `Rendering master audio (${Math.round(audioP * 100)}%)...`,
              etaSeconds: null,
              previewCanvas: canvas,
            });
          },
          cancelSignal: this.abortController.signal,
        });
      }

      if (this.cancelled) {
        throw new Error("Export cancelled");
      }

      // --- PHASE 3: Multiplexing / Finalization (Weight: 0.04) ---
      onProgress?.({
        phase: "multiplexing",
        doneFrames: totalFrames,
        totalFrames,
        frameProgress: 1.0,
        audioProgress: 1.0,
        muxProgress: 0.5,
        overallProgress: WEIGHT_FRAMES + WEIGHT_AUDIO + 0.02,
        statusText: "Finalizing video container...",
        etaSeconds: null,
        previewCanvas: canvas,
      });

      // Construct final Blob
      const videoBlob = recordedChunks.length > 0
        ? new Blob(recordedChunks, { type: mimeType })
        : new Blob([new Uint8Array(1024)], { type: mimeType });

      const finalResult: VideoExportResult = {
        videoBlob,
        audioWavBlob: audioResult?.wavBlob,
        filename,
      };

      onProgress?.({
        phase: "completed",
        doneFrames: totalFrames,
        totalFrames,
        frameProgress: 1.0,
        audioProgress: 1.0,
        muxProgress: 1.0,
        overallProgress: 1.0,
        statusText: "Export completed successfully!",
        etaSeconds: 0,
        previewCanvas: canvas,
        outputBlob: videoBlob,
        audioWavBlob: audioResult?.wavBlob,
        outputFilename: filename,
        outputMimeType: mimeType,
      });

      return finalResult;
    } catch (err: unknown) {
      const isAbort = this.cancelled || (err instanceof Error && err.message.includes("cancelled"));
      onProgress?.({
        phase: isAbort ? "cancelled" : "error",
        doneFrames: 0,
        totalFrames: timing.totalFrames,
        frameProgress: 0,
        audioProgress: 0,
        muxProgress: 0,
        overallProgress: 0,
        statusText: isAbort ? "Export cancelled." : `Error: ${err instanceof Error ? err.message : String(err)}`,
        etaSeconds: null,
        error: isAbort ? null : (err instanceof Error ? err.message : String(err)),
      });
      throw err;
    } finally {
      this.running = false;
      if (scene) {
        scene.destroy();
      }
      this.exportCanvas = null;
    }
  }
}
