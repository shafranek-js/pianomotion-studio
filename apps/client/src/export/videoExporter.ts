import {
  AudioBufferSource,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import { computeSha256Hex } from "../audio/soundfont/soundfontAssetStore";
import { parseSf2Async } from "../audio/soundfont/sf2Parser";
import { PianoScene } from "../render";
import { renderOfflineAudio, type OfflineAudioRenderResult } from "./offlineAudioRenderer";
import { calculateExportTiming } from "./videoDimensions";
import {
  createBoundedBlobVideoSink,
  createFileVideoSink,
  beginSaveFilePicker,
  MAX_VIDEO_BLOB_BYTES,
  type SaveFileHandleLike,
  type VideoOutputSink,
} from "./videoExportSink";
import { VideoExportAnalysisWorker, type VideoExportMotionProvider } from "./videoExportAnalysisWorker";
import { freezeVideoExportSnapshot } from "./videoExportSnapshot";
import type { AudioBufferLike } from "./wavEncoder";
import type {
  ExportSceneDataSource,
  ExportSourceIdentity,
  VideoExportOptions,
  VideoExportProgress,
} from "./types";
import type { PerformancePlan } from "@handthesia/contracts";

export const WEIGHT_FRAMES = 0.86;
export const WEIGHT_AUDIO = 0.10;
export const WEIGHT_MUX = 0.04;

export interface SavedVideoFile {
  name: string;
  sizeBytes: number;
  mimeType: string;
}

export interface VideoExportResult {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  savedFile?: SavedVideoFile;
  boundedBlob?: Blob;
}

interface CodecSelection {
  video: "avc" | "vp9" | "vp8";
  audio: "aac" | "opus" | null;
  mimeType: "video/mp4" | "video/webm";
}

export interface VideoCodecCapability {
  supported: boolean;
  reason: string | null;
}

export interface ExportTiming {
  startTime: number;
  durationSeconds: number;
  totalFrames: number;
  fps: number;
  speed: number;
}

export function getSupportedVideoMimeType(preferredFormat: "mp4" | "webm" = "mp4"): string {
  return preferredFormat === "webm" ? "video/webm" : "video/mp4";
}

export async function preflightVideoCodecs(
  format: "mp4" | "webm",
  options: { width: number; height: number; fps: number; includeAudio: boolean },
): Promise<CodecSelection> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("Video export requires WebCodecs VideoEncoder support.");
  }
  const videoOptions = { width: options.width, height: options.height, frameRate: options.fps };
  let video: CodecSelection["video"];
  let audio: CodecSelection["audio"] = null;
  if (format === "mp4") {
    if (!(await canEncodeVideo("avc", videoOptions))) {
      throw new Error("This browser cannot encode H.264/AVC video for MP4 at the selected dimensions and frame rate.");
    }
    video = "avc";
    if (options.includeAudio) {
      if (typeof AudioEncoder === "undefined" || !(await canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: 44_100 }))) {
        throw new Error("This browser cannot encode AAC audio for MP4.");
      }
      audio = "aac";
    }
    return { video, audio, mimeType: "video/mp4" };
  }

  if (await canEncodeVideo("vp9", videoOptions)) video = "vp9";
  else if (await canEncodeVideo("vp8", videoOptions)) video = "vp8";
  else throw new Error("This browser cannot encode VP9 or VP8 video for WebM at the selected dimensions and frame rate.");
  if (options.includeAudio) {
    if (typeof AudioEncoder === "undefined" || !(await canEncodeAudio("opus", { numberOfChannels: 2, sampleRate: 44_100 }))) {
      throw new Error("This browser cannot encode Opus audio for WebM.");
    }
    audio = "opus";
  }
  return { video, audio, mimeType: "video/webm" };
}

/** Checks the selected settings without opening an output picker or starting an export. */
export async function queryVideoCodecCapabilities(options: {
  width: number;
  height: number;
  fps: number;
  includeAudio: boolean;
}): Promise<Record<"mp4" | "webm", VideoCodecCapability>> {
  const check = async (format: "mp4" | "webm"): Promise<VideoCodecCapability> => {
    try {
      await preflightVideoCodecs(format, options);
      return { supported: true, reason: null };
    } catch (error) {
      return {
        supported: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const [mp4, webm] = await Promise.all([check("mp4"), check("webm")]);
  return { mp4, webm };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === "undefined") throw new Error("Video export requires a browser canvas.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function createNativeAudioBufferSlice(buffer: AudioBufferLike, start: number, end: number): AudioBuffer {
  if (typeof AudioBuffer === "undefined") throw new Error("Video export requires Web Audio AudioBuffer support.");
  const length = end - start;
  if (length <= 0) throw new RangeError("Audio encoder chunk must contain at least one sample.");
  const native = new AudioBuffer({
    numberOfChannels: Math.min(2, buffer.numberOfChannels),
    length,
    sampleRate: buffer.sampleRate,
  });
  for (let channel = 0; channel < native.numberOfChannels; channel += 1) {
    native.copyToChannel(new Float32Array(buffer.getChannelData(channel).subarray(start, end)), channel);
  }
  return native;
}

function makeFilename(title: string, preset: string, fps: number, format: "mp4" | "webm"): string {
  const safeTitle = (title || "performance").trim().replace(/[^a-zA-Z0-9_\u0400-\u04FF-]/g, "_") || "performance";
  return `${safeTitle}_${preset}_${fps}fps.${format}`;
}

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]));
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

export function assertReplanMatchesFrozenSource(
  sourceIdentity: ExportSourceIdentity,
  frozenDocument: ExportSceneDataSource["document"],
  frozenPerformance: PerformancePlan,
  replanned: Awaited<ReturnType<VideoExportAnalysisWorker["replan"]>>,
): void {
  const performance = replanned.performancePlan;
  if (!replanned.document || canonicalJson(replanned.document) !== canonicalJson(frozenDocument)) {
    throw new Error("The independent export replan changed the frozen source document.");
  }
  if (!performance || performance.projectId !== sourceIdentity.projectId ||
      performance.inputRevision !== sourceIdentity.revision ||
      performance.engineVersion !== sourceIdentity.engineVersion ||
      performance.profileId !== frozenPerformance.profileId ||
      performance.profileRevision !== frozenPerformance.profileRevision ||
      performance.fingeringPlanId !== replanned.fingeringPlan?.planId ||
      canonicalJson(replanned.fingeringPlan?.assignments) !== canonicalJson(sourceIdentity.fingeringPlan.assignments) ||
      canonicalJson(performance.events) !== canonicalJson(frozenPerformance.events)) {
    throw new Error("The independent export replan does not match the frozen performance events.");
  }
}

function openOutputSink(
  mode: VideoExportOptions["outputMode"],
  filename: string,
  mimeType: string,
): Promise<SaveFileHandleLike> | null {
  if (mode === "bounded-blob") return null;
  const promise = beginSaveFilePicker(filename, mimeType);
  // Picker cancellation can happen while codec preflight is still pending.
  // Keep the original promise for the awaited result, but mark it handled now.
  promise?.catch(() => {});
  return promise;
}

async function selectOutputSink(
  mode: VideoExportOptions["outputMode"],
  pickerPromise: Promise<SaveFileHandleLike> | null,
  mimeType: string,
  blobLimitBytes: number | undefined,
): Promise<{ sink: VideoOutputSink; handle?: SaveFileHandleLike }> {
  if (mode === "file" && !pickerPromise) {
    throw new Error("File output is unavailable because this browser does not support the File System Access API.");
  }
  if (pickerPromise) {
    const handle = await pickerPromise;
    return { sink: await createFileVideoSink(handle), handle };
  }
  return { sink: createBoundedBlobVideoSink(mimeType, blobLimitBytes ?? MAX_VIDEO_BLOB_BYTES) };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Video export canceled", "AbortError");
}

/** Headless WebCodecs video exporter with a dedicated planning Worker and backpressured output. */
export class VideoExporter {
  private cancelled = false;
  private running = false;
  private abortController = new AbortController();
  private exportCanvas: HTMLCanvasElement | null = null;

  public cancel(): void {
    this.cancelled = true;
    this.abortController.abort();
  }

  public isCancelled(): boolean { return this.cancelled; }
  public isRunning(): boolean { return this.running; }
  public getExportCanvas(): HTMLCanvasElement | null { return this.exportCanvas; }

  public async exportVideo(
    source: ExportSceneDataSource,
    optionsInput: VideoExportOptions,
    onProgress?: (progress: VideoExportProgress) => void,
  ): Promise<VideoExportResult> {
    if (this.running) throw new Error("An export is already running.");

    // This copy is deliberately the first export operation: all live editor state is frozen before a picker or Worker can await.
    const snapshot = freezeVideoExportSnapshot(source, optionsInput);
    const options = snapshot.options;
    this.cancelled = false;
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const format = options.format ?? "mp4";
    const initialMimeType = getSupportedVideoMimeType(format);
    const filename = makeFilename(snapshot.document.title, options.preset, options.fps, format);
    let pickerPromise: Promise<SaveFileHandleLike> | null;
    let scene: PianoScene | null = null;
    let analysisWorker: VideoExportAnalysisWorker | null = null;
    let motionProvider: VideoExportMotionProvider;
    let output: Output | null = null;
    let sink: VideoOutputSink | null = null;
    let completed = false;
    let totalFrames = 0;
    let frameCount = 0;
    let audioProgress = 0;
    const startedAt = Date.now();

    try {
      pickerPromise = openOutputSink(options.outputMode ?? "auto", filename, initialMimeType);
      const safeWidth = Math.max(2, Math.floor(options.width / 2) * 2);
      const safeHeight = Math.max(2, Math.floor(options.height / 2) * 2);
      if (safeWidth !== options.width || safeHeight !== options.height || options.width < 2 || options.height < 2) {
        throw new RangeError("Video dimensions must be positive even integers.");
      }
      if (![30, 60].includes(options.fps) || !Number.isFinite(options.speed) || options.speed < 0.25 || options.speed > 2) {
        throw new RangeError("Video export requires 30 or 60 FPS and a playback speed from 0.25x to 2x.");
      }

      const leadIn = snapshot.settings.leadInSeconds ?? -2;
      const rawTiming = calculateExportTiming(
        leadIn,
        snapshot.document.durationSeconds,
        options.speed,
        options.tailSeconds,
        options.fps,
      );
      totalFrames = rawTiming.totalFrames;
      const timing: ExportTiming = {
        ...rawTiming,
        durationSeconds: rawTiming.totalFrames / rawTiming.fps,
      };
      const codec = await preflightVideoCodecs(format, {
        width: safeWidth,
        height: safeHeight,
        fps: options.fps,
        includeAudio: options.includeAudio && options.audioSource !== "none",
      });
      throwIfCancelled(signal);
      const selectedSink = await selectOutputSink(options.outputMode ?? "auto", pickerPromise, codec.mimeType, options.blobLimitBytes);
      sink = selectedSink.sink;

      const canvas = createCanvas(safeWidth, safeHeight);
      this.exportCanvas = canvas;
      onProgress?.({
        phase: "preparing", doneFrames: 0, totalFrames, frameProgress: 0, audioProgress: 0,
        muxProgress: 0, overallProgress: 0.01, statusText: "Freezing project and rebuilding export plans…",
        etaSeconds: null, previewCanvas: canvas,
      });

      const actualMidiHash = await computeSha256Hex(snapshot.sourceIdentity.originalMidiBytes);
      if (actualMidiHash !== snapshot.sourceIdentity.resource.sha256) {
        throw new Error("The frozen original MIDI bytes no longer match the saved source resource hash.");
      }
      analysisWorker = new VideoExportAnalysisWorker(snapshot.settings.calculationEngine);
      const replanned = await analysisWorker.replan(snapshot, signal, (message) => {
        onProgress?.({
          phase: "preparing", doneFrames: 0, totalFrames, frameProgress: 0, audioProgress: 0,
          muxProgress: 0, overallProgress: 0.04, statusText: message, etaSeconds: null, previewCanvas: canvas,
        });
      });
      assertReplanMatchesFrozenSource(
        snapshot.sourceIdentity,
        snapshot.document,
        snapshot.performancePlan,
        replanned,
      );
      motionProvider = analysisWorker.createMotionProvider(replanned, signal, (message) => {
        onProgress?.({
          phase: "preparing", doneFrames: 0, totalFrames, frameProgress: 0, audioProgress: 0,
          muxProgress: 0, overallProgress: 0.08, statusText: message, etaSeconds: null, previewCanvas: canvas,
        });
      });
      throwIfCancelled(signal);
      scene = await PianoScene.create({
        target: canvas,
        fixedViewport: { width: safeWidth, height: safeHeight, resolution: 1 },
        song: snapshot.document,
        performancePlan: snapshot.performancePlan,
        // The bounded streamed buffer wins when it has a current pose; the frozen
        // sparse plan keeps hands visible during lead-in/tail and uncovered gaps.
        motionPlan: snapshot.motionPlan ?? null,
        motionBuffer: motionProvider.buffer,
        keyStyle: replanned.keyStyle,
        displaySettings: {
          showFingerLabels: snapshot.settings.showFingerLabels,
          showNoteNames: snapshot.settings.showNoteNames,
          skinStyle: snapshot.settings.skinStyle,
          showHandShadow: snapshot.settings.showHandShadow,
          renderCapFps: 0,
        },
        pixelsPerSecond: 180,
      });

      let soundFont: Awaited<ReturnType<typeof parseSf2Async>> | null = null;
      if (options.includeAudio && options.audioSource === "soundfont") {
        const identity = snapshot.sourceIdentity;
        const frozenAsset = identity.soundFontAssetBlob ?? identity.soundFontAssetBytes ?? null;
        const frozenAssetSize = frozenAsset instanceof Blob ? frozenAsset.size : frozenAsset?.byteLength ?? 0;
        if (identity.activeOutputId !== "soundfont" || !identity.soundFontAssetId ||
            !frozenAsset || frozenAssetSize === 0) {
          throw new Error("The selected SoundFont is no longer loaded for this exact source identity.");
        }
        const frozenAssetHash = await computeSha256Hex(frozenAsset, { signal });
        if (frozenAssetHash !== identity.soundFontAssetId) {
          throw new Error("The frozen SoundFont bytes do not match the active source asset identity.");
        }
        throwIfCancelled(signal);
        soundFont = await parseSf2Async(frozenAsset, { signal });
        if (soundFont.sampleSource) soundFont.sampleSource.assetId = identity.soundFontAssetId;
      }
      if (options.includeAudio && options.audioSource === "recording" && !snapshot.audioRecording) {
        throw new Error("The selected synchronized recording is not available in the export snapshot.");
      }
      throwIfCancelled(signal);

      let audioResult: OfflineAudioRenderResult | null = null;
      const wantsAudio = options.includeAudio && options.audioSource !== "none";
      if (wantsAudio) {
        audioResult = await renderOfflineAudio({
          document: snapshot.document,
          performancePlan: snapshot.performancePlan,
          soundFont,
          audioRecording: options.audioSource === "recording" ? snapshot.audioRecording : null,
          audioOffset: snapshot.audioOffset,
          speed: timing.speed,
          startTime: timing.startTime,
          durationSeconds: timing.durationSeconds,
          volume: snapshot.settings.masterVolume ?? 0.8,
          createWav: false,
          onProgress: (value) => {
            audioProgress = value;
            onProgress?.({
              phase: "rendering_audio", doneFrames: 0, totalFrames, frameProgress: 0,
              audioProgress: value, muxProgress: 0,
              overallProgress: value * WEIGHT_AUDIO,
              statusText: `Rendering master audio (${Math.round(value * 100)}%)…`,
              etaSeconds: null, previewCanvas: canvas,
            });
          },
          cancelSignal: signal,
        });
      }

      output = new Output({
        format: format === "mp4" ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
        target: sink.target,
      });
      const canvasSource = new CanvasSource(canvas, { codec: codec.video, bitrate: 8_000_000 });
      // WebM needs DefaultDuration to describe each cluster's last frame.
      // Declaring the fixed rate also keeps container timestamps on the frame grid.
      output.addVideoTrack(canvasSource, { frameRate: timing.fps });
      const audioSource = wantsAudio && codec.audio
        ? new AudioBufferSource({ codec: codec.audio, bitrate: 192_000 }, { startTimestamp: 0 })
        : null;
      if (audioSource) output.addAudioTrack(audioSource);
      await output.start();

      let nextAudioFrame = 0;
      const audioBuffer = audioResult?.audioBuffer ?? null;
      const chunkFrames = audioBuffer ? Math.max(1, Math.round(audioBuffer.sampleRate * 0.5)) : 0;
      const addReadyAudio = async (frameEndSeconds: number, force = false) => {
        if (!audioSource || !audioBuffer) return;
        while (nextAudioFrame < audioBuffer.length) {
          const nextEnd = Math.min(audioBuffer.length, nextAudioFrame + chunkFrames);
          if (!force && nextEnd / audioBuffer.sampleRate > frameEndSeconds + 1e-9) return;
          throwIfCancelled(signal);
          await audioSource.add(createNativeAudioBufferSlice(audioBuffer, nextAudioFrame, nextEnd));
          nextAudioFrame = nextEnd;
        }
      };

      const songDuration = replanned.document!.durationSeconds;
      for (let i = 0; i < totalFrames; i += 1) {
        throwIfCancelled(signal);
        const timestampSeconds = i / timing.fps;
        const songTime = timing.startTime + timestampSeconds * timing.speed;
        const motionStart = Math.max(0, Math.min(songDuration, songTime));
        const motionEnd = Math.min(songDuration, motionStart + 1.5);
        await motionProvider.ensureCoverage(motionStart, motionEnd);
        throwIfCancelled(signal);
        scene.update(songTime);
        scene.getApp().renderer.render(scene.getApp().stage);
        await canvasSource.add(timestampSeconds, 1 / timing.fps);
        await addReadyAudio(timestampSeconds + 1 / timing.fps);
        frameCount = i + 1;
        const frameProgress = frameCount / totalFrames;
        const overallProgress = frameProgress * WEIGHT_FRAMES + audioProgress * WEIGHT_AUDIO;
        const elapsedSeconds = (Date.now() - startedAt) / 1000;
        const etaSeconds = frameProgress > 0.03
          ? Math.max(0, Math.round((elapsedSeconds / frameProgress) * (1 - frameProgress)))
          : null;
        onProgress?.({
          phase: "rendering_frames", doneFrames: frameCount, totalFrames,
          frameProgress, audioProgress, muxProgress: 0, overallProgress,
          statusText: `Rendering frames ${frameCount} / ${totalFrames} (${Math.round(frameProgress * 100)}%)`,
          etaSeconds, previewCanvas: canvas,
        });
        if (i % 4 === 0 || i === totalFrames - 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await addReadyAudio(timing.durationSeconds, true);
      throwIfCancelled(signal);

      onProgress?.({
        phase: "multiplexing", doneFrames: totalFrames, totalFrames, frameProgress: 1,
        audioProgress: 1, muxProgress: 0.5,
        overallProgress: WEIGHT_FRAMES + WEIGHT_AUDIO + 0.02,
        statusText: "Finalizing video file…", etaSeconds: null, previewCanvas: canvas,
      });
      await output.finalize();
      if (output.state !== "finalized") throw new Error("Video container did not finalize successfully.");
      // Precise codec strings become available only after encoded packets exist.
      // Awaiting this before feeding frames/audio deadlocks the muxer.
      const exactMimeType = await output.getMimeType();
      if (!sink.isClosed()) throw new Error("Video output sink did not close successfully.");
      const sizeBytes = sink.getSizeBytes();
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error("Video export produced an empty output file.");
      const boundedBlob = sink.getBlob() ?? undefined;
      if (sink.mode === "bounded-blob" && (!boundedBlob || boundedBlob.size !== sizeBytes)) {
        throw new Error("Bounded Blob output did not close with the expected byte length.");
      }
      const actualFilename = selectedSink.handle?.name || filename;
      const savedFile = sink.mode === "file"
        ? { name: actualFilename, sizeBytes, mimeType: exactMimeType }
        : undefined;
      const result: VideoExportResult = {
        filename: actualFilename,
        mimeType: exactMimeType,
        sizeBytes,
        ...(savedFile ? { savedFile } : {}),
        ...(boundedBlob ? { boundedBlob } : {}),
      };
      completed = true;
      onProgress?.({
        phase: "completed", doneFrames: totalFrames, totalFrames,
        frameProgress: 1, audioProgress: 1, muxProgress: 1,
        overallProgress: 1, statusText: "Export completed successfully.", etaSeconds: 0,
        previewCanvas: canvas, outputBlob: boundedBlob ?? null,
        outputSavedFile: savedFile ?? null, outputFilename: actualFilename,
        outputMimeType: exactMimeType,
      });
      return result;
    } catch (error: unknown) {
      const abortError = this.cancelled || signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError");
      if (sink && !completed) await sink.abort(error);
      if (output && output.state !== "finalized" && output.state !== "canceled") {
        await output.cancel().catch(() => {});
      }
      const message = error instanceof Error ? error.message : String(error);
      onProgress?.({
        phase: abortError ? "cancelled" : "error", doneFrames: frameCount, totalFrames,
        frameProgress: totalFrames ? frameCount / totalFrames : 0, audioProgress,
        muxProgress: 0, overallProgress: 0,
        statusText: abortError ? "Export canceled." : `Export failed: ${message}`,
        etaSeconds: null, error: abortError ? null : message,
      });
      throw error;
    } finally {
      analysisWorker?.dispose();
      if (scene) scene.destroy();
      if (sink && !completed) await sink.abort(new DOMException("Video export did not complete", "AbortError"));
      this.running = false;
      this.exportCanvas = null;
    }
  }
}
