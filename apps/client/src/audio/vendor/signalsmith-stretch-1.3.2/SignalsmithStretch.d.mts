export interface StretchScheduleOptions {
  output?: number;
  active?: boolean;
  input?: number;
  rate?: number;
  semitones?: number;
  tonalityHz?: number;
  formantSemitones?: number;
  formantCompensation?: boolean;
  formantBaseHz?: number;
  loopStart?: number;
  loopEnd?: number;
}

export interface StretchNode extends AudioWorkletNode {
  inputTime: number;
  schedule(options: StretchScheduleOptions): Promise<void>;
  start(when?: number): Promise<void>;
  stop(when?: number): Promise<void>;
  addBuffers(buffers: Float32Array[]): Promise<number>;
  dropBuffers(toSeconds?: number): Promise<void>;
  latency(): number;
  setUpdateInterval(seconds: number, callback?: (time: number) => void): Promise<void>;
  configure(options: { blockMs?: number; intervalMs?: number; splitComputation?: boolean }): Promise<void>;
}

export default function SignalsmithStretch(
  audioContext: AudioContext | OfflineAudioContext,
  options?: AudioWorkletNodeOptions,
): Promise<StretchNode>;
