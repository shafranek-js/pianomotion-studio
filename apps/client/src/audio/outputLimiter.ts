/**
 * Shared output protection, placed AFTER the user master gain.
 * Native compression is stereo-linked; the final safety guard is per-channel.
 * The compressor handles sustained overload; a per-channel waveshaper catches
 * transient overshoot. The guard can alter stereo balance during overload.
 * This is a sample-peak ceiling, not a true-peak guarantee. Native compressor
 * lookahead adds browser latency.
 */
export const OUTPUT_PEAK_CEILING = 0.98;

export interface OutputLimiter {
  readonly input: AudioNode;
  dispose(): void;
}

export function createOutputLimiter(
  context: BaseAudioContext,
  destination: AudioNode = context.destination,
): OutputLimiter {
  const compressor = context.createDynamicsCompressor();
  const ceiling = context.createWaveShaper();
  compressor.channelCount = 2;
  compressor.channelCountMode = "explicit";
  // A sub-zero threshold triggers native automatic makeup gain, boosting even
  // quiet notes. Zero keeps unity gain below overload without compensation.
  compressor.threshold.setValueAtTime(0, context.currentTime);
  compressor.knee.setValueAtTime(0, context.currentTime);
  compressor.ratio.setValueAtTime(20, context.currentTime);
  compressor.attack.setValueAtTime(0, context.currentTime);
  compressor.release.setValueAtTime(0.05, context.currentTime);

  // An odd-length curve includes zero exactly. Linear interpolation preserves
  // signals below the ceiling; out-of-range inputs map to the curve endpoints.
  const curve = new Float32Array(65537);
  // Float32(.98) rounds slightly upward; reserve a tiny margin so the stored
  // endpoint, and therefore the actual sample peak, remains below .98.
  const ceilingSample = OUTPUT_PEAK_CEILING - 1e-7;
  for (let index = 0; index < curve.length; index += 1) {
    const sample = (index * 2) / (curve.length - 1) - 1;
    curve[index] = Math.max(-ceilingSample, Math.min(ceilingSample, sample));
  }
  ceiling.curve = curve;
  // Upsampling/downsampling AFTER the ceiling could introduce fresh overshoot.
  ceiling.oversample = "none";
  compressor.connect(ceiling);
  ceiling.connect(destination);
  let disposed = false;
  return {
    input: compressor,
    dispose() {
      if (disposed) return;
      disposed = true;
      compressor.disconnect();
      ceiling.disconnect();
    },
  };
}
