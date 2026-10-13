/**
 * Waveform generation and viewport extraction matching desktop audio_sync.py.
 * PEAK_T = 0.005s (5ms per peak slice).
 */

export const PEAK_SLICE_SECONDS = 0.005; // 5ms slice
export const COARSE_OFFSET_STEP_SECONDS = 0.1; // 100ms coarse nudge/drag
export const FINE_OFFSET_STEP_SECONDS = 0.01; // 10ms fine nudge/drag with Shift

export interface ViewportPeaks {
  min: Float32Array;
  max: Float32Array;
}

/**
 * Generates waveform peak amplitudes across all channels for each sliceSeconds window (default 5ms = 0.005s).
 * Computes peak amplitude Math.max(Math.abs(min), Math.abs(max)) across all channels,
 * normalized to [0, 1] matching desktop audio_sync.py.
 */
export function generateWaveformPeaks(
  buffer: AudioBuffer,
  sliceSeconds = PEAK_SLICE_SECONDS,
): Float32Array {
  if (!buffer || buffer.length === 0 || buffer.numberOfChannels === 0) {
    return new Float32Array(1);
  }

  const samplesPerSlice = Math.max(1, Math.floor(sliceSeconds * buffer.sampleRate));
  const numSlices = Math.floor(buffer.length / samplesPerSlice);

  if (numSlices === 0) {
    return new Float32Array(1);
  }

  const numChannels = buffer.numberOfChannels;
  const channelData: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channelData.push(buffer.getChannelData(c));
  }

  const peaks = new Float32Array(numSlices);
  let globalMax = 0;

  for (let i = 0; i < numSlices; i++) {
    const startSample = i * samplesPerSlice;
    const endSample = startSample + samplesPerSlice;

    let slicePeak = 0;
    for (let c = 0; c < numChannels; c++) {
      const data = channelData[c]!;
      for (let s = startSample; s < endSample; s++) {
        const absVal = Math.abs(data[s]!);
        if (absVal > slicePeak) {
          slicePeak = absVal;
        }
      }
    }

    peaks[i] = slicePeak;
    if (slicePeak > globalMax) {
      globalMax = slicePeak;
    }
  }

  // Normalize to 0..1 matching desktop: top = float(p.max()) or 1.0; return p / top
  const normalizationFactor = globalMax > 0 ? 1 / globalMax : 1;
  if (globalMax > 0 && Math.abs(normalizationFactor - 1) > 1e-6) {
    for (let i = 0; i < numSlices; i++) {
      peaks[i] = peaks[i]! * normalizationFactor;
    }
  }

  return peaks;
}

/**
 * Extracts min and max peak amplitudes for each horizontal pixel column in a canvas viewport.
 * Enables instant 60 FPS waveform rendering on zoom and scroll without scanning raw samples.
 *
 * @param peaks Precomputed 5ms peaks array
 * @param startTime Visible start time in song/recording seconds
 * @param endTime Visible end time in song/recording seconds
 * @param targetWidthPx Target canvas width in pixels
 * @param totalDuration Total duration of the recording in seconds
 * @returns { min: Float32Array, max: Float32Array } of length targetWidthPx
 */
export function extractViewportPeaks(
  peaks: Float32Array,
  startTime: number,
  endTime: number,
  targetWidthPx: number,
  totalDuration: number,
): ViewportPeaks {
  const width = Math.max(1, Math.floor(targetWidthPx));
  const min = new Float32Array(width);
  const max = new Float32Array(width);

  if (!peaks || peaks.length === 0 || totalDuration <= 0 || width <= 0) {
    return { min, max };
  }

  const sliceDuration = totalDuration / peaks.length;
  const timeSpan = endTime - startTime;

  for (let x = 0; x < width; x++) {
    const colT0 = startTime + (x / width) * timeSpan;
    const colT1 = startTime + ((x + 1) / width) * timeSpan;

    const spanStart = Math.min(colT0, colT1);
    const spanEnd = Math.max(colT0, colT1);

    // If entirely outside recording bounds [0, totalDuration], amplitude is 0
    if (spanEnd <= 0 || spanStart >= totalDuration) {
      min[x] = 0;
      max[x] = 0;
      continue;
    }

    // Determine slice index range within recording
    const clampedStart = Math.max(0, spanStart);
    const clampedEnd = Math.min(totalDuration, spanEnd);

    const startSlice = Math.max(0, Math.floor(clampedStart / sliceDuration));
    const endT = Math.max(clampedStart, clampedEnd - 1e-9);
    const endSlice = Math.min(peaks.length - 1, Math.floor(endT / sliceDuration));

    let colPeak = 0;
    if (startSlice <= endSlice) {
      for (let s = startSlice; s <= endSlice; s++) {
        const val = peaks[s]!;
        if (val > colPeak) {
          colPeak = val;
        }
      }
    } else {
      const s = Math.min(peaks.length - 1, Math.max(0, startSlice));
      colPeak = peaks[s] ?? 0;
    }

    max[x] = colPeak;
    min[x] = -colPeak;
  }

  return { min, max };
}

/**
 * Calculates updated recording offset in seconds from a horizontal pixel drag.
 * Holding Shift enables fine 10ms steps vs coarse 100ms steps.
 *
 * @param startOffset Starting recording offset in seconds
 * @param deltaPx Horizontal mouse delta in pixels (positive = shifted right)
 * @param pixelsPerSecond Zoom scale in pixels per second
 * @param isShiftHeld Whether Shift is pressed (fine 10ms steps vs 100ms steps)
 * @returns Quantized new offset in seconds
 */
export function calculateDragOffset(
  startOffset: number,
  deltaPx: number,
  pixelsPerSecond: number,
  isShiftHeld: boolean,
): number {
  const pps = Math.max(1e-6, pixelsPerSecond);
  const step = isShiftHeld ? FINE_OFFSET_STEP_SECONDS : COARSE_OFFSET_STEP_SECONDS;
  const deltaSeconds = deltaPx / pps;
  const rawOffset = startOffset + deltaSeconds;
  const stepped = Math.round(rawOffset / step) * step;
  return Number(stepped.toFixed(4));
}
