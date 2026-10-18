import { getAudioContext, setMasterVolume } from "../audioContext.ts";
import type { PedalState, RestoredPianoVoice } from "../sampler.ts";
import { PianoSampler } from "../sampler.ts";
import { SoundFontSynth } from "../soundfont/soundfontSynth.ts";
import { WebMidiOutputManager } from "../../midi/webMidiOutput.ts";
import type { PerformancePlan } from "@handthesia/contracts";
import { derivePerformanceStateAt } from "../performancePlan.ts";

export interface PlaybackState {
  voices: RestoredPianoVoice[];
  pedals: PedalState;
}

export interface PerformanceOutputWindow {
  startSeconds: number;
  endSeconds: number;
}

export type PerformanceOutputId = "synth" | "soundfont" | "webmidi";

/**
 * Unified interface for audio/MIDI playback outputs.
 * Allows seamless switching between Web Audio synth, SoundFont 2, and Web MIDI hardware.
 */
export interface PerformanceOutput {
  readonly id: PerformanceOutputId;
  noteOn(noteId: string, pitch: number, velocity: number, scheduledTime: number): void;
  noteOff(noteId: string, pitch: number | undefined, scheduledTime: number): void;
  pedal(controller: 64 | 66 | 67, value: number, scheduledTime: number): void;
  panic(): void;
  cancelScheduledFutureEvents(time: number): void;
  restoreState(state: PlaybackState): void;
  /** Optional file-backed output readiness; includes voices held at startSeconds. */
  prepareWindow?(plan: PerformancePlan, startSeconds: number, endSeconds: number, signal?: AbortSignal): Promise<void>;
  isWindowPrepared?(plan: PerformancePlan, startSeconds: number, endSeconds: number): boolean;
  /** Optional atomic preparation for disjoint windows that must be ready together (loop head + current segment). */
  prepareWindows?(plan: PerformancePlan, windows: readonly PerformanceOutputWindow[], signal?: AbortSignal): Promise<void>;
  isWindowsPrepared?(plan: PerformancePlan, windows: readonly PerformanceOutputWindow[]): boolean;
  warmInteractiveWindow?(plan: PerformancePlan, startSeconds: number, endSeconds: number): void;
  setVolume?(volume: number): void;
  subscribeUnavailable?(listener: (error: Error) => void): () => void;
  dispose(): void;
}

/**
 * Built-in polyphonic additive synthesizer output.
 */
export class SynthPerformanceOutput implements PerformanceOutput {
  readonly id = "synth" as const;
  private readonly sampler: PianoSampler;
  private readonly ownsSampler: boolean;

  constructor(sampler?: PianoSampler) {
    if (sampler) {
      this.sampler = sampler;
      this.ownsSampler = false;
    } else {
      this.sampler = new PianoSampler();
      this.ownsSampler = true;
    }
  }

  public getSampler(): PianoSampler {
    return this.sampler;
  }

  public noteOn(noteId: string, pitch: number, velocity: number, scheduledTime?: number): void {
    this.sampler.noteOn(noteId, pitch, velocity, scheduledTime);
  }

  public noteOff(noteId: string, _pitch?: number, scheduledTime?: number): void {
    this.sampler.noteOff(noteId, scheduledTime);
  }

  public pedal(controller: 64 | 66 | 67, value: number, scheduledTime?: number): void {
    this.sampler.pedal(controller, value, scheduledTime);
  }

  public panic(): void {
    this.sampler.silenceAll();
  }

  public cancelScheduledFutureEvents(time: number): void {
    this.sampler.cancelScheduledFutureEvents(time);
  }

  public restoreState(state: PlaybackState): void {
    this.sampler.restoreState(state);
  }

  public setVolume(volume: number): void {
    setMasterVolume(volume);
  }

  public dispose(): void {
    this.sampler.silenceAll();
    if (this.ownsSampler) {
      this.sampler.dispose();
    }
  }
}

/**
 * SoundFont 2 (SF2) acoustic playback output.
 */
export class SoundFontPerformanceOutput implements PerformanceOutput {
  readonly id = "soundfont" as const;
  private readonly synth: SoundFontSynth;
  private readonly fallbackSampler = new PianoSampler();
  private readonly activeNotes = new Map<string, number>();
  private preparedWindows: {
    plan: PerformancePlan;
    windows: PerformanceOutputWindow[];
    notes: Array<{ pitch: number; velocity: number }>;
  } | null = null;

  constructor(synth: SoundFontSynth) {
    this.synth = synth;
  }

  public getSynth(): SoundFontSynth {
    return this.synth;
  }

  public async prepareWindow(
    plan: PerformancePlan,
    startSeconds: number,
    endSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    // Linear playback prepares from the transport playhead, which is negative
    // during the lead-in. Keep that legacy single-window API permissive and
    // clamp its sample request to song time zero; the atomic loop-window API
    // deliberately remains non-negative and strict.
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds < startSeconds) {
      throw new RangeError("SoundFont preparation window must have finite, ordered bounds.");
    }
    if (endSeconds < 0) return;
    return this.prepareWindows(plan, [{ startSeconds: Math.max(0, startSeconds), endSeconds }], signal);
  }

  public async prepareWindows(
    plan: PerformancePlan,
    windows: readonly PerformanceOutputWindow[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.validateWindows(windows);
    if (this.isWindowsPrepared(plan, windows)) return;
    if (signal?.aborted) throw new DOMException("SoundFont window preparation was cancelled.", "AbortError");
    const notes = new Map<string, { pitch: number; velocity: number }>();
    for (const window of windows) {
      for (const note of collectWindowNotes(plan, window.startSeconds, window.endSeconds)) {
        notes.set(`${note.pitch}:${note.velocity}`, note);
      }
    }
    const preparedNotes = [...notes.values()];
    await this.synth.prepareNotes(preparedNotes, signal);
    if (signal?.aborted) throw new DOMException("SoundFont window preparation was cancelled.", "AbortError");
    this.preparedWindows = { plan, windows: windows.map((window) => ({ ...window })), notes: preparedNotes };
  }

  public warmInteractiveWindow(plan: PerformancePlan, startSeconds: number, endSeconds: number): void {
    const notes = collectWindowNotes(plan, startSeconds, endSeconds);
    this.synth.warmNotesInCache?.(notes);
  }

  public isWindowPrepared(plan: PerformancePlan, startSeconds: number, endSeconds: number): boolean {
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds < startSeconds) return false;
    if (endSeconds < 0) return true;
    return this.isWindowsPrepared(plan, [{ startSeconds: Math.max(0, startSeconds), endSeconds }]);
  }

  public isWindowsPrepared(plan: PerformancePlan, windows: readonly PerformanceOutputWindow[]): boolean {
    if (!this.areWindowsValid(windows)) return false;
    const prepared = this.preparedWindows;
    if (!prepared || prepared.plan !== plan || !this.synth.areNotesPrepared(prepared.notes)) return false;
    return windows.every((window) => prepared.windows.some((candidate) =>
      window.startSeconds >= candidate.startSeconds && window.endSeconds <= candidate.endSeconds));
  }

  public noteOn(noteId: string, pitch: number, velocity: number, scheduledTime?: number): void {
    this.activeNotes.set(noteId, pitch);
    try {
      this.synth.noteOn(pitch, velocity, noteId, scheduledTime);
    } catch {
      this.synth.warmNotesInCache?.([{ pitch, velocity }]);
      if (!this.synth.tryNoteOnNearestReady?.(pitch, velocity, noteId, scheduledTime)) {
        this.fallbackSampler.noteOn(noteId, pitch, velocity, scheduledTime);
      }
    }
  }

  public noteOff(noteId: string, pitch?: number, scheduledTime?: number): void {
    const effectivePitch = pitch ?? this.activeNotes.get(noteId);
    try {
      this.synth.noteOff(noteId, effectivePitch, scheduledTime);
    } catch {
      // Ignored
    }
    this.fallbackSampler.noteOff(noteId, scheduledTime);
    this.activeNotes.delete(noteId);
  }

  public pedal(controller: 64 | 66 | 67, value: number, scheduledTime?: number): void {
    this.synth.pedalChange(controller, value, scheduledTime);
    this.fallbackSampler.pedal(controller, value, scheduledTime);
  }

  public panic(): void {
    this.synth.silenceAll();
    this.fallbackSampler.silenceAll();
    this.activeNotes.clear();
  }

  public cancelScheduledFutureEvents(time: number): void {
    this.synth.cancelScheduledFutureEvents(time);
    this.fallbackSampler.cancelScheduledFutureEvents(time);
    this.activeNotes.clear();
    for (const voice of this.synth.getKeyDownNotes()) {
      this.activeNotes.set(voice.noteId, voice.pitch);
    }
  }

  public restoreState(state: PlaybackState): void {
    this.activeNotes.clear();
    // SoundFont owns restored voices; the additive fallback only needs the
    // matching pedal baseline so failed/missing samples cannot leave old audio
    // sounding or leak pedal state across a seek or loop re-anchor.
    this.fallbackSampler.restoreState({ voices: [], pedals: state.pedals });
    this.synth.restoreState(state);
    for (const voice of state.voices) this.activeNotes.set(voice.noteId, voice.pitch);
  }

  public setVolume(volume: number): void {
    // The SoundFont node feeds the shared master gain; volume is applied there once.
    void volume;
  }

  public dispose(): void {
    this.panic();
    this.fallbackSampler.dispose();
    this.preparedWindows = null;
    this.synth.dispose();
  }

  private validateWindows(windows: readonly PerformanceOutputWindow[]): void {
    if (!this.areWindowsValid(windows)) {
      throw new RangeError("SoundFont preparation windows must be non-empty, finite, non-negative, and ordered by start time.");
    }
  }

  private areWindowsValid(windows: readonly PerformanceOutputWindow[]): boolean {
    if (windows.length === 0) return false;
    let previousStart = Number.NEGATIVE_INFINITY;
    for (const window of windows) {
      if (!Number.isFinite(window.startSeconds) || !Number.isFinite(window.endSeconds) ||
          window.startSeconds < 0 || window.endSeconds < window.startSeconds || window.startSeconds < previousStart) {
        return false;
      }
      previousStart = window.startSeconds;
    }
    return true;
  }
}

function collectWindowNotes(
  plan: PerformancePlan,
  startSeconds: number,
  endSeconds: number,
): Array<{ pitch: number; velocity: number }> {
  const notes = new Map<string, { pitch: number; velocity: number }>();
  for (const voice of derivePerformanceStateAt(plan, startSeconds).voices) {
    notes.set(voice.noteId, { pitch: voice.pitch, velocity: voice.velocity });
  }
  const events = plan.events;
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (events[middle]!.timeSeconds <= startSeconds) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < events.length; index++) {
    const event = events[index]!;
    if (event.timeSeconds > endSeconds) break;
    if (event.type === "press") notes.set(event.noteId, { pitch: event.pitch, velocity: event.velocity });
  }
  return [...notes.values()];
}

/**
 * Web MIDI hardware output sending sub-millisecond scheduled MIDI commands.
 */
export class WebMidiPerformanceOutput implements PerformanceOutput {
  readonly id = "webmidi" as const;
  private readonly manager: WebMidiOutputManager;
  private readonly audioContext: AudioContext;
  private readonly channel: number;
  private readonly activeNotes = new Map<string, { pitch: number; startTime: number; releaseTime?: number }>();
  private readonly pedalEvents: Array<{ controller: 64 | 66 | 67; value: number; time: number }> = [];
  private readonly unavailableListeners = new Set<(error: Error) => void>();
  private unsubscribeMidi: (() => void) | null = null;
  private activeDeviceId: string | null = null;

  constructor(manager: WebMidiOutputManager, audioContext?: AudioContext, channel = 0) {
    this.manager = manager;
    this.audioContext = audioContext ?? getAudioContext();
    this.channel = Math.max(0, Math.min(15, Math.round(channel)));
    this.activeDeviceId = this.manager.getStatus().activeDeviceId;

    this.unsubscribeMidi = this.manager.subscribe((status) => {
      const previouslyConnected = this.activeDeviceId !== null;
      this.activeDeviceId = status.activeDeviceId;
      if (previouslyConnected && !status.activeDeviceId) {
        this.activeNotes.clear();
        this.pedalEvents.length = 0;
        const error = new Error(status.errorMessage ?? "The active MIDI output disconnected.");
        for (const listener of this.unavailableListeners) listener(error);
      }
    });
  }

  public getManager(): WebMidiOutputManager {
    return this.manager;
  }

  private computeMidiTimestamp(scheduledTime?: number): number | undefined {
    if (scheduledTime === undefined) {
      return undefined;
    }
    const audioNow = this.audioContext.currentTime;
    const deltaMs = (scheduledTime - audioNow) * 1000;
    return performance.now() + Math.max(0, deltaMs);
  }

  public noteOn(noteId: string, pitch: number, velocity: number, scheduledTime?: number): void {
    const time = scheduledTime ?? this.audioContext.currentTime;
    this.activeNotes.set(noteId, { pitch, startTime: time });
    const ts = this.computeMidiTimestamp(scheduledTime);
    this.manager.sendNoteOn(pitch, velocity, this.channel, ts);
  }

  public noteOff(noteId: string, pitch?: number, scheduledTime?: number): void {
    const tracked = this.activeNotes.get(noteId);
    const resolvedPitch = pitch ?? tracked?.pitch;
    if (resolvedPitch !== undefined) {
      const time = scheduledTime ?? this.audioContext.currentTime;
      if (tracked) tracked.releaseTime = time;
      const ts = this.computeMidiTimestamp(scheduledTime);
      this.manager.sendNoteOff(resolvedPitch, this.channel, ts);
    }
  }

  public pedal(controller: 64 | 66 | 67, value: number, scheduledTime?: number): void {
    const ts = this.computeMidiTimestamp(scheduledTime);
    const time = scheduledTime ?? this.audioContext.currentTime;
    this.pedalEvents.push({ controller, value, time });
    this.manager.sendControlChange(controller, value, this.channel, ts);
  }

  public panic(): void {
    this.manager.silenceAll();
    this.activeNotes.clear();
    this.pedalEvents.length = 0;
  }

  public cancelScheduledFutureEvents(time: number): void {
    this.manager.clearScheduledMessages();
    for (const [noteId, note] of this.activeNotes) {
      if (note.startTime > time) {
        this.activeNotes.delete(noteId);
      } else if (note.releaseTime !== undefined && note.releaseTime > time) {
        note.releaseTime = undefined;
      } else if (note.releaseTime !== undefined && note.releaseTime <= time) {
        this.activeNotes.delete(noteId);
      }
    }
    const retainedPedals = this.pedalEvents.filter((event) => event.time <= time);
    this.pedalEvents.splice(0, this.pedalEvents.length, ...retainedPedals);
  }

  public restoreState(state: PlaybackState): void {
    this.panic();

    const now = this.audioContext.currentTime;
    const held = state.voices.filter((voice) => voice.keyState === "down" || voice.heldBySostenuto || voice.sustainedBySustain);
    for (const voice of held.filter((item) => item.heldBySostenuto)) {
      this.sendRestoredNoteOn(voice.noteId, voice.pitch, voice.velocity, now);
    }
    this.manager.sendControlChange(66, state.pedals.sostenuto ? 127 : 0, this.channel);
    for (const voice of held.filter((item) => !item.heldBySostenuto)) {
      this.sendRestoredNoteOn(voice.noteId, voice.pitch, voice.velocity, now);
    }
    this.manager.sendControlChange(64, state.pedals.sustain ? 127 : 0, this.channel);
    this.manager.sendControlChange(67, state.pedals.soft ? 127 : 0, this.channel);
    for (const voice of held) {
      if (voice.keyState === "up") {
        this.manager.sendNoteOff(voice.pitch, this.channel);
        const tracked = this.activeNotes.get(voice.noteId);
        if (tracked) tracked.releaseTime = now;
      }
    }
  }

  public setVolume(volume: number): void {
    // Standard MIDI CC 7 (Channel Volume)
    const clampedMidiVolume = Math.max(0, Math.min(127, Math.round(volume * 127)));
    this.manager.sendControlChange(7, clampedMidiVolume, this.channel);
  }

  public subscribeUnavailable(listener: (error: Error) => void): () => void {
    this.unavailableListeners.add(listener);
    return () => this.unavailableListeners.delete(listener);
  }

  public dispose(): void {
    this.panic();
    if (this.unsubscribeMidi) {
      this.unsubscribeMidi();
      this.unsubscribeMidi = null;
    }
    this.unavailableListeners.clear();
  }

  private sendRestoredNoteOn(noteId: string, pitch: number, velocity: number, time: number): void {
    this.activeNotes.set(noteId, { pitch, startTime: time });
    this.manager.sendNoteOn(pitch, velocity, this.channel);
  }
}
