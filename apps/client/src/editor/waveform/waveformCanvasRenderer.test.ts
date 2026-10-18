import { describe, expect, it } from "vitest";
import type { DecodedAudioRecording } from "../../audio/recording/audioDecoder.ts";
import { PEAK_SLICE_SECONDS } from "../../audio/recording/waveformGenerator.ts";
import { drawWaveformColumns } from "./waveformCanvasRenderer.ts";

interface DrawCall {
  x: number;
  y: number;
  width: number;
  height: number;
  fillStyle: string | CanvasGradient | CanvasPattern;
}

function makeRecording(peaks: Float32Array): DecodedAudioRecording {
  return {
    buffer: {} as AudioBuffer,
    durationSeconds: 10,
    sampleRate: 48_000,
    numberOfChannels: 1,
    peaks,
  };
}

function drawAt(options: {
  seekTimeSeconds: number;
  playheadX: number;
  offsetSeconds: number;
  speed: number;
  songDuration?: number;
}) {
  const targetRecordingTime = options.seekTimeSeconds + options.offsetSeconds;
  const targetPeakIndex = Math.floor(targetRecordingTime / PEAK_SLICE_SECONDS);
  const peaks = new Float32Array(2_000);
  peaks[targetPeakIndex] = 1;
  const recording = makeRecording(peaks);
  const calls: DrawCall[] = [];
  let fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  const context = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = value;
    },
    fillRect(x: number, y: number, width: number, height: number) {
      calls.push({ x, y, width, height, fillStyle });
    },
  } as CanvasRenderingContext2D;

  const pixelsPerSecond = 100;
  const width = options.playheadX + 1;
  drawWaveformColumns({
    context,
    recording,
    width,
    height: 100,
    offsetSeconds: options.offsetSeconds,
    songDuration: options.songDuration ?? 10,
    pixelsPerSecond,
    scrollX: options.seekTimeSeconds * pixelsPerSecond - options.playheadX,
    speed: options.speed,
  });

  return calls;
}

describe("drawWaveformColumns", () => {
  it("draws the peak at the sought and scrolled song time with recording offset at every playback speed", () => {
    const seekAndOffsetCases = [
      { seekTimeSeconds: 4, playheadX: 0, offsetSeconds: 0.25 },
      { seekTimeSeconds: 4, playheadX: 2, offsetSeconds: -0.25 },
      { seekTimeSeconds: 1.37, playheadX: 1, offsetSeconds: 0.12 },
      { seekTimeSeconds: 0.62, playheadX: 3, offsetSeconds: -0.1 },
    ];

    for (const speed of [0.25, 0.5, 1, 2]) {
      for (const view of seekAndOffsetCases) {
        const calls = drawAt({ ...view, speed });

        expect(calls, `speed ${speed}, seek ${view.seekTimeSeconds}, offset ${view.offsetSeconds}`)
          .toHaveLength(view.playheadX + 1);
        expect(calls[view.playheadX]).toMatchObject({
          x: view.playheadX,
          width: 1,
          y: 3,
          height: 94,
        });
        expect(calls.filter((_, index) => index !== view.playheadX).every((call) => call.height === 2))
          .toBe(true);
      }
    }
  });

  it("keeps recording positions fixed as the viewport scrolls and dims song-external peaks", () => {
    const calls = drawAt({
      seekTimeSeconds: 4.5,
      playheadX: 2,
      offsetSeconds: -0.5,
      speed: 0.5,
      songDuration: 4,
    });

    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ y: 3, height: 94, fillStyle: "#3e526c" });
  });
});
