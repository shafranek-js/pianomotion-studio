import type { ExportResolutionPreset, VideoExportDimensions } from "./types";

export const VIDEO_FPS = 30;
export const VIDEO_TAIL_S = 1.5;

export const RESOLUTION_PRESETS: Record<ExportResolutionPreset, { width: number; height: number; label: string }> = {
  "1080p": { width: 1920, height: 1080, label: "1080p Full HD (1920×1080)" },
  "720p": { width: 1280, height: 720, label: "720p HD (1280×720)" },
  "4k": { width: 3840, height: 2160, label: "4K Ultra HD (3840×2160)" },
  "window": { width: 0, height: 0, label: "Window / Current Size" },
};

/**
 * Ensures dimensions are even integers as required by standard video encoders (H.264 / VP9 4:2:0 chroma).
 */
export function ensureEvenDimension(dim: number): number {
  const rounded = Math.max(2, Math.round(dim));
  return rounded - (rounded % 2);
}

/**
 * Resolves the export pixel width and height for a given preset, ensuring even integers.
 */
export function getVideoDimensions(
  preset: ExportResolutionPreset,
  currentWidth = 1280,
  currentHeight = 720,
): VideoExportDimensions {
  if (preset === "window") {
    const w = ensureEvenDimension(Math.max(320, currentWidth));
    const h = ensureEvenDimension(Math.max(240, currentHeight));
    return {
      width: w,
      height: h,
      label: `Window (${w}×${h})`,
    };
  }

  const base = RESOLUTION_PRESETS[preset];
  return {
    width: ensureEvenDimension(base.width),
    height: ensureEvenDimension(base.height),
    label: base.label,
  };
}

export interface ExportTimingResult {
  startTime: number;
  durationSeconds: number;
  totalFrames: number;
  fps: number;
  speed: number;
}

/**
 * Calculates start time, duration, and frame count for video export:
 *   t0 = leadInSeconds (e.g. -2.0)
 *   seconds = (songDuration - t0) / speed + tailSeconds
 *   totalFrames = Math.max(1, Math.round(seconds * fps))
 */
export function calculateExportTiming(
  leadInSeconds: number,
  songDuration: number,
  speed = 1.0,
  tailSeconds = VIDEO_TAIL_S,
  fps = VIDEO_FPS,
): ExportTimingResult {
  const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1.0;
  const t0 = Number.isFinite(leadInSeconds) ? leadInSeconds : -2.0;
  const dur = Number.isFinite(songDuration) ? Math.max(0, songDuration) : 0;
  const tail = Number.isFinite(tailSeconds) ? Math.max(0, tailSeconds) : VIDEO_TAIL_S;
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : VIDEO_FPS;

  const seconds = Math.max(0.1, (dur - t0) / safeSpeed + tail);
  const totalFrames = Math.max(1, Math.round(seconds * safeFps));

  return {
    startTime: t0,
    durationSeconds: seconds,
    totalFrames,
    fps: safeFps,
    speed: safeSpeed,
  };
}
