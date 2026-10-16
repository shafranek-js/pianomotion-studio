/**
 * SoundFont 2 (SF2) Types and Interfaces (W042, W043)
 */

export interface Sf2Header {
  name: string;
  versionMajor: number;
  versionMinor: number;
  soundEngine?: string;
}

export interface Sf2SampleHeader {
  name: string;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  sampleRate: number;
  originalPitch: number;
  pitchCorrection: number;
  /** Raw SF2/SF3 wSampleType value, including compression and ROM flags. */
  sampleType: number;
  /** SF3 bit 4: this sample is stored as an individually encoded stream. */
  compressed?: boolean;
  /** Compressed byte range in the `smpl` chunk, with an exclusive end. */
  compressedByteStart?: number;
  compressedByteEnd?: number;
  /** Decoded mono frame count from the Ogg Vorbis final granule position. */
  decodedFrameCount?: number;
  /** Index of the opposite channel for SF2 rightSample/leftSample. */
  sampleLink?: number;
  audioBuffer?: AudioBuffer;
}

export interface Sf2Zone {
  keyRange: [number, number]; // [minPitch, maxPitch] (0..127)
  velRange: [number, number]; // [minVel, maxVel] (0..127)
  sampleIndex: number;
  /** Original instrument identity, used to keep stereo pairs within a layer. */
  instrumentId?: number;
  presetZoneId?: number;
  instrumentZoneId?: number;
  rootKey?: number;
  pitchCorrection?: number;
  sampleModes?: number; // 0 = no loop, 1 = continuous loop, 3 = loop while key down
  pan?: number; // -500..500
  initialAttenuationDb?: number;
  attackSeconds?: number;
  holdSeconds?: number;
  decaySeconds?: number;
  sustainPercent?: number; // 0..100
  releaseSeconds?: number;
}

export interface Sf2Preset {
  name: string;
  presetNumber: number;
  bankNumber: number;
  zones: Sf2Zone[];
}

export interface Sf2SoundFont {
  header: Sf2Header;
  presets: Sf2Preset[];
  samples: Sf2SampleHeader[];
  rawSampleData?: Int16Array;
  /** Immutable file-backed PCM. Production banks do not materialize all samples. */
  sampleSource?: {
    blob: Blob;
    /** Verified content identity, allowing live/export to share decoded samples. */
    assetId?: string;
    sampleDataOffset: number;
    /** Number of PCM words at the beginning of the sample data chunk. */
    sampleCount: number;
    /** Complete `smpl` payload size, including any compressed streams. */
    sampleDataByteLength?: number;
  };
}

/** SF2 base sample type occupies the low four bits; SF3 compression is bit 4. */
export const SF2_SAMPLE_TYPE_MASK = 0x000f;
export const SF2_SAMPLE_COMPRESSED_FLAG = 0x0010;
export const SF2_SAMPLE_ROM_FLAG = 0x8000;

export function getSf2BaseSampleType(sampleType: number): number {
  return sampleType & SF2_SAMPLE_TYPE_MASK;
}

export interface SoundFontSynthOptions {
  audioContext: AudioContext | OfflineAudioContext;
  destinationNode?: AudioNode;
  maxPolyphony?: number;
}
