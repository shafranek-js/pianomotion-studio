export {
  closeAudioContext,
  getAudioContext,
  getMasterGain,
  getMasterVolume,
  isAudioContextRunning,
  resumeAudioContext,
  setAudioContextForTesting,
  setMasterVolume,
} from "./audioContext.ts";

export {
  PianoSampler,
  type PedalState,
  type PianoSamplerRestoreState,
  type PianoSamplerOptions,
  type PianoTimbre,
  type RestoredPianoVoice,
} from "./sampler.ts";

export {
  Transport,
  type TransportOptions,
  type TransportState,
} from "./transport.ts";

export {
  decodeAudioRecording,
  isAudioFormatSupported,
  assertDecodedAudioBudget,
  decodedPcmBytes,
  MAX_AUDIO_FILE_SIZE_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  MAX_DECODED_PCM_BYTES,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_AUDIO_MIME_TYPES,
  type DecodedAudioRecording,
} from "./recording/audioDecoder.ts";

export {
  calculateDragOffset,
  extractViewportPeaks,
  generateWaveformPeaks,
  PEAK_SLICE_SECONDS,
  COARSE_OFFSET_STEP_SECONDS,
  FINE_OFFSET_STEP_SECONDS,
  type ViewportPeaks,
} from "./recording/waveformGenerator.ts";

export {
  SyncedAudioSource,
} from "./recording/syncedAudioSource.ts";

export * from "./output/index.ts";
export * from "./soundfont/index.ts";
export * from "./performancePlan.ts";
export * from "./signalsmithStretch.ts";
export * from "./recording/timeStretch.ts";
