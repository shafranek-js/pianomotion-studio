import type { DecodedAudioRecording } from "../../audio/recording/audioDecoder.ts";
import { mapSongTimeToRecordingPosition } from "../../audio/recording/timeStretch.ts";
import { PEAK_SLICE_SECONDS } from "../../audio/recording/waveformGenerator.ts";

const WAVE_COLOR = "#6096d2";
const WAVE_DIM = "#3e526c";

export interface WaveformColumnRenderOptions {
  context: CanvasRenderingContext2D;
  recording: DecodedAudioRecording;
  width: number;
  height: number;
  offsetSeconds: number;
  songDuration: number;
  pixelsPerSecond: number;
  scrollX: number;
  /** Compatibility input; playback speed is applied by the audio track, not the timeline map. */
  speed?: number;
}

/** Draws the recording peaks visible in the song-timeline viewport. */
export function drawWaveformColumns({
  context,
  recording,
  width,
  height,
  offsetSeconds,
  songDuration,
  pixelsPerSecond,
  scrollX,
}: WaveformColumnRenderOptions): void {
  if (recording.peaks.length === 0 || recording.durationSeconds <= 0) return;

  const peaks = recording.peaks;
  const peaksLen = peaks.length;
  const mid = height / 2;
  const pps = Math.max(1e-6, pixelsPerSecond);
  let activeColor = "";

  for (let x = 0; x < width; x++) {
    const songTime = (scrollX + x) / pps;
    const recordingTime = mapSongTimeToRecordingPosition(songTime, offsetSeconds);
    if (recordingTime < 0 || recordingTime > recording.durationSeconds) continue;

    const sliceIndex = Math.floor(recordingTime / PEAK_SLICE_SECONDS);
    const peakAmplitude = sliceIndex >= 0 && sliceIndex < peaksLen ? peaks[sliceIndex]! : 0;
    const halfHeight = Math.max(1, Math.round(peakAmplitude * (mid - 3)));
    const color = songTime >= 0 && songTime <= songDuration ? WAVE_COLOR : WAVE_DIM;

    if (color !== activeColor) {
      context.fillStyle = color;
      activeColor = color;
    }

    context.fillRect(x, mid - halfHeight, 1, halfHeight * 2);
  }
}
