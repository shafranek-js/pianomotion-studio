import { midiLoader } from "@handthesia/engine-ts";
import { getAudioContext, getMasterGain } from "./audioContext.ts";

export interface AccompanimentTrackInfo {
  readonly id: string;
  readonly trackIndex: number;
  readonly name: string;
  readonly program: number;
  readonly noteCount: number;
}

export interface AccompanimentNote {
  readonly noteId: string;
  readonly trackId: string;
  readonly program: number;
  readonly pitch: number;
  readonly velocity: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export type AccompanimentEvent =
  | {
      readonly type: "press";
      readonly noteId: string;
      readonly trackId: string;
      readonly program: number;
      readonly pitch: number;
      readonly velocity: number;
      readonly timeSeconds: number;
    }
  | {
      readonly type: "release";
      readonly noteId: string;
      readonly pitch: number;
      readonly timeSeconds: number;
    };

export interface AccompanimentPlan {
  readonly tracks: readonly AccompanimentTrackInfo[];
  readonly notes: readonly AccompanimentNote[];
  readonly events: readonly AccompanimentEvent[];
}

export const EMPTY_ACCOMPANIMENT_PLAN: AccompanimentPlan = {
  tracks: [],
  notes: [],
  events: [],
};

export const DEFAULT_ACCOMPANIMENT_VOLUME = 0.65;

/**
 * Extracts non-piano pitched instrument tracks from a multi-instrument MIDI buffer
 * when the file contains both a piano part and accompaniment/solo instruments.
 */
export function extractAccompanimentPlan(
  rawMidiBytes: ArrayBuffer | Uint8Array | null | undefined,
): AccompanimentPlan {
  if (!rawMidiBytes) return EMPTY_ACCOMPANIMENT_PLAN;
  const bytes =
    rawMidiBytes instanceof Uint8Array ? rawMidiBytes : new Uint8Array(rawMidiBytes);
  if (bytes.byteLength < 14) return EMPTY_ACCOMPANIMENT_PLAN;

  let pm: midiLoader.PrettyMIDI;
  try {
    [pm] = midiLoader.read_midi(bytes);
  } catch {
    return EMPTY_ACCOMPANIMENT_PLAN;
  }

  const pitchedInstruments: Array<[number, midiLoader.PrettyMidiInstrument]> = [];
  for (let i = 0; i < pm.instruments.length; i += 1) {
    const inst = pm.instruments[i]!;
    if (!inst.is_drum && inst.notes.length > 0) {
      pitchedInstruments.push([i, inst]);
    }
  }

  const pianoInstruments = pitchedInstruments.filter(([, inst]) =>
    midiLoader.is_piano_track(inst),
  );
  const accompanimentInstruments = pitchedInstruments.filter(
    ([, inst]) => !midiLoader.is_piano_track(inst),
  );

  // Accompaniment mode applies only when there is both a piano part and at least one other pitched instrument.
  if (pianoInstruments.length === 0 || accompanimentInstruments.length === 0) {
    return EMPTY_ACCOMPANIMENT_PLAN;
  }

  // Match the negative start offset shift from sanitize_notes on piano notes
  let t0 = 0;
  const pianoStarts: number[] = [];
  for (const [, inst] of pianoInstruments) {
    for (const n of inst.notes) {
      if (Number.isFinite(n.start) && Number.isFinite(n.end) && n.end >= n.start) {
        pianoStarts.push(n.start);
      }
    }
  }
  if (pianoStarts.length > 0) {
    const minStart = pianoStarts.reduce((minimum, start) => Math.min(minimum, start), Number.POSITIVE_INFINITY);
    if (minStart < 0) t0 = minStart;
  }

  const tracks: AccompanimentTrackInfo[] = [];
  const notes: AccompanimentNote[] = [];
  const events: AccompanimentEvent[] = [];

  for (const [trackIdx, inst] of accompanimentInstruments) {
    const trackId = `acc-track-${trackIdx}`;
    const rawName = (inst.name || "").trim();
    const displayName = rawName || gmProgramFamilyLabel(inst.program, trackIdx);
    const validNotes: AccompanimentNote[] = [];

    for (let nIdx = 0; nIdx < inst.notes.length; nIdx += 1) {
      const raw = inst.notes[nIdx]!;
      if (!Number.isFinite(raw.start) || !Number.isFinite(raw.end) || raw.end < raw.start) {
        continue;
      }
      const startSeconds = Math.max(0, raw.start - t0);
      const endSeconds = Math.max(startSeconds + 0.05, raw.end - t0);
      const pitch = Math.max(0, Math.min(127, Math.trunc(raw.pitch)));
      const velocity = Math.max(1, Math.min(127, Math.trunc(raw.velocity)));
      const noteId = `${trackId}:note-${nIdx}`;

      const accNote: AccompanimentNote = {
        noteId,
        trackId,
        program: inst.program,
        pitch,
        velocity,
        startSeconds,
        endSeconds,
      };
      validNotes.push(accNote);
      notes.push(accNote);

      events.push({
        type: "press",
        noteId,
        trackId,
        program: inst.program,
        pitch,
        velocity,
        timeSeconds: startSeconds,
      });
      events.push({
        type: "release",
        noteId,
        pitch,
        timeSeconds: endSeconds,
      });
    }

    if (validNotes.length > 0) {
      tracks.push({
        id: trackId,
        trackIndex: trackIdx,
        name: displayName,
        program: inst.program,
        noteCount: validNotes.length,
      });
    }
  }

  notes.sort((a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch);
  events.sort((a, b) => {
    if (a.timeSeconds !== b.timeSeconds) return a.timeSeconds - b.timeSeconds;
    if (a.type !== b.type) return a.type === "release" ? -1 : 1;
    return a.pitch - b.pitch;
  });

  return { tracks, notes, events };
}

function gmProgramFamilyLabel(program: number, trackIdx: number): string {
  if (program >= 24 && program <= 31) return "Guitar";
  if (program >= 32 && program <= 39) return "Bass";
  if (program >= 40 && program <= 47) return "Strings";
  if (program >= 48 && program <= 55) return "Ensemble / Voice";
  if (program >= 56 && program <= 63) return "Brass";
  if (program >= 64 && program <= 71) return "Reed";
  if (program >= 72 && program <= 79) return "Flute / Pipe";
  return `Instrument ${trackIdx + 1}`;
}

interface ActiveAccompanimentVoice {
  noteId: string;
  pitch: number;
  oscillators: OscillatorNode[];
  voiceGain: GainNode;
  releaseSeconds: number;
  released: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface AccompanimentSamplerOptions {
  audioContext?: AudioContext;
  destinationNode?: AudioNode;
  maxPolyphony?: number;
  initialVolume?: number;
  initialEnabled?: boolean;
}

/** A backing engine shares transport timing, but owns its own gain and voices. */
export interface AccompanimentBackend {
  setVolume(volume: number): void;
  getVolume(): number;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  noteOn(noteId: string, pitch: number, velocity: number, program?: number, scheduledTime?: number): void;
  noteOff(noteId: string, scheduledTime?: number): void;
  allNotesOff(): void;
  dispose(): void;
  prepareWindows?(plan: AccompanimentPlan, windows: readonly AccompanimentWindow[], signal?: AbortSignal): Promise<void>;
  isWindowsPrepared?(plan: AccompanimentPlan, windows: readonly AccompanimentWindow[]): boolean;
  getFallbackPrograms?(plan: AccompanimentPlan): number[];
  getBuiltinFallbackPrograms?(plan: AccompanimentPlan): number[];
}

export interface AccompanimentWindow {
  startSeconds: number;
  endSeconds: number;
}

/**
 * Dedicated Web Audio synthesizer for accompaniment tracks with independent
 * volume GainNode and soft ensemble/vocal/string articulation.
 */
export class AccompanimentSampler {
  private readonly audioContext: AudioContext;
  private readonly busGain: GainNode;
  private readonly maxPolyphony: number;
  private readonly activeVoices = new Map<string, ActiveAccompanimentVoice>();
  private volume: number;
  private enabled: boolean;
  private disposed = false;

  constructor(options: AccompanimentSamplerOptions = {}) {
    this.audioContext = options.audioContext ?? getAudioContext();
    const destination =
      options.destinationNode ??
      (options.audioContext ? options.audioContext.destination : getMasterGain());
    this.maxPolyphony = options.maxPolyphony ?? 32;
    this.volume = Math.max(0, Math.min(1, options.initialVolume ?? DEFAULT_ACCOMPANIMENT_VOLUME));
    this.enabled = options.initialEnabled ?? true;

    this.busGain = this.audioContext.createGain();
    this.busGain.gain.setValueAtTime(
      this.enabled ? this.volume : 0,
      this.audioContext.currentTime,
    );
    this.busGain.connect(destination);
  }

  public setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0));
    this.volume = clamped;
    this.applyBusGain();
  }

  public getVolume(): number {
    return this.volume;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    this.applyBusGain();
    if (!this.enabled) {
      this.allNotesOff();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  private applyBusGain(): void {
    const target = this.enabled ? this.volume : 0;
    try {
      this.busGain.gain.setValueAtTime(target, this.audioContext.currentTime);
    } catch {
      this.busGain.gain.value = target;
    }
  }

  public noteOn(
    noteId: string,
    pitch: number,
    velocity: number,
    program = 48,
    scheduledTime?: number,
  ): void {
    if (this.disposed || !this.enabled || this.volume <= 0) return;
    const now = this.audioContext.currentTime;
    const startTime = Math.max(now, scheduledTime ?? now);

    if (this.activeVoices.has(noteId)) {
      this.forceStopVoice(noteId, startTime);
    }
    if (this.activeVoices.size >= this.maxPolyphony) {
      const oldestKey = this.activeVoices.keys().next().value;
      if (oldestKey) this.forceStopVoice(oldestKey, startTime);
    }

    const frequency = 440 * Math.pow(2, (pitch - 69) / 12);
    const normVel = Math.max(0.18, Math.min(1, velocity / 127));
    const isPlucked = (program >= 24 && program <= 39) || program === 46;
    const attackSeconds = isPlucked ? 0.006 : 0.028;
    const releaseSeconds = isPlucked ? 0.08 : 0.14;
    const peakGain = Math.max(0.01, Math.pow(normVel, 1.5) * 0.14);

    const filter = this.audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(
      Math.min(10000, frequency * (isPlucked ? 4.2 : 2.8) + 350),
      startTime,
    );
    filter.Q.setValueAtTime(0.8, startTime);

    const voiceGain = this.audioContext.createGain();
    voiceGain.gain.setValueAtTime(0.0001, startTime);
    voiceGain.gain.exponentialRampToValueAtTime(peakGain, startTime + attackSeconds);
    if (isPlucked) {
      voiceGain.gain.setTargetAtTime(peakGain * 0.25, startTime + attackSeconds, 0.45);
    } else {
      voiceGain.gain.setTargetAtTime(peakGain * 0.78, startTime + attackSeconds, 0.25);
    }

    const oscillators: OscillatorNode[] = [];
    const detunes = [-3.5, 3.5];
    for (const detune of detunes) {
      const osc = this.audioContext.createOscillator();
      osc.type = isPlucked ? "triangle" : "sawtooth";
      osc.frequency.setValueAtTime(frequency, startTime);
      osc.detune.setValueAtTime(detune, startTime);
      osc.connect(filter);
      try {
        osc.start(startTime);
      } catch {
        // Ignore in mocks
      }
      oscillators.push(osc);
    }

    filter.connect(voiceGain);
    voiceGain.connect(this.busGain);

    this.activeVoices.set(noteId, {
      noteId,
      pitch,
      oscillators,
      voiceGain,
      releaseSeconds,
      released: false,
    });
  }

  public noteOff(noteId: string, scheduledTime?: number): void {
    const voice = this.activeVoices.get(noteId);
    if (!voice || voice.released) return;
    voice.released = true;

    const now = this.audioContext.currentTime;
    const releaseStart = Math.max(now, scheduledTime ?? now);
    const stopAt = releaseStart + voice.releaseSeconds * 4;

    try {
      voice.voiceGain.gain.cancelScheduledValues(releaseStart);
      voice.voiceGain.gain.setTargetAtTime(0.0001, releaseStart, voice.releaseSeconds * 0.5);
    } catch {
      // Ignore in mock contexts
    }

    for (const osc of voice.oscillators) {
      try {
        osc.stop(stopAt);
      } catch {
        // Ignore
      }
    }

    const delayMs = Math.max(20, (stopAt - now) * 1000 + 25);
    voice.cleanupTimer = setTimeout(() => {
      this.cleanupVoice(noteId);
    }, delayMs);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.allNotesOff();
    try {
      this.busGain.disconnect();
    } catch {
      // Ignore disconnected mock or browser nodes.
    }
  }

  public allNotesOff(): void {
    const now = this.audioContext.currentTime;
    for (const noteId of [...this.activeVoices.keys()]) {
      this.forceStopVoice(noteId, now);
    }
  }

  private forceStopVoice(noteId: string, when: number): void {
    const voice = this.activeVoices.get(noteId);
    if (!voice) return;
    if (voice.cleanupTimer) clearTimeout(voice.cleanupTimer);
    for (const osc of voice.oscillators) {
      try {
        osc.stop(when);
        osc.disconnect();
      } catch {
        // Ignore
      }
    }
    try {
      voice.voiceGain.disconnect();
    } catch {
      // Ignore
    }
    this.activeVoices.delete(noteId);
  }

  private cleanupVoice(noteId: string): void {
    const voice = this.activeVoices.get(noteId);
    if (!voice) return;
    if (voice.cleanupTimer) clearTimeout(voice.cleanupTimer);
    for (const osc of voice.oscillators) {
      try {
        osc.disconnect();
      } catch {
        // Ignore already disconnected nodes.
      }
    }
    try {
      voice.voiceGain.disconnect();
    } catch {
      // Ignore already disconnected nodes.
    }
    this.activeVoices.delete(noteId);
  }
}
