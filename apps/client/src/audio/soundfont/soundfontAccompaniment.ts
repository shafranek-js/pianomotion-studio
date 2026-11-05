import { getAudioContext, getMasterGain } from "../audioContext.ts";
import {
  AccompanimentSampler, DEFAULT_ACCOMPANIMENT_VOLUME,
  type AccompanimentBackend, type AccompanimentPlan, type AccompanimentSamplerOptions,
  type AccompanimentWindow,
} from "../accompaniment.ts";
import { SoundFontSynth } from "./soundfontSynth.ts";
import type { Sf2SoundFont } from "./types.ts";

export interface SoundFontAccompanimentOptions extends AccompanimentSamplerOptions {
  soundFont: Sf2SoundFont;
  /** Already parsed immutable built-in bank, used only for missing GM programs. */
  fallbackSoundFont?: Sf2SoundFont;
}

interface ProgramRoute {
  soundFont: Sf2SoundFont;
  presetIndex: number;
  source: "selected" | "builtin";
}

/** Selected bank -> built-in GM bank -> oscillator, with exact bank-zero programs. */
export class SoundFontAccompanimentSampler implements AccompanimentBackend {
  private readonly context: AudioContext;
  private readonly bus: GainNode;
  private readonly fallback: AccompanimentSampler;
  private readonly synths = new Map<number, SoundFontSynth>();
  private readonly voices = new Map<string, { synth: SoundFontSynth; pitch: number }>();
  private volume: number;
  private enabled: boolean;
  private disposed = false;
  private preparation: AbortController | null = null;
  private prepared: { plan: AccompanimentPlan; windows: AccompanimentWindow[]; notes: Map<number, Array<{ pitch: number; velocity: number }>> } | null = null;

  constructor(private readonly options: SoundFontAccompanimentOptions) {
    this.context = options.audioContext ?? getAudioContext();
    this.volume = clampVolume(options.initialVolume ?? DEFAULT_ACCOMPANIMENT_VOLUME);
    this.enabled = options.initialEnabled ?? true;
    this.bus = this.context.createGain();
    this.bus.connect(options.destinationNode ?? (options.audioContext ? this.context.destination : getMasterGain()));
    this.fallback = new AccompanimentSampler({ audioContext: this.context, destinationNode: this.bus, initialVolume: 1 });
    this.applyGain();
  }

  public getFallbackPrograms(plan: AccompanimentPlan): number[] {
    return [...new Set(plan.notes.map((note) => note.program))]
      .filter((program) => this.resolveProgram(program) === null).sort((a, b) => a - b);
  }

  public getBuiltinFallbackPrograms(plan: AccompanimentPlan): number[] {
    return [...new Set(plan.notes.map((note) => note.program))]
      .filter((program) => this.resolveProgram(program)?.source === "builtin").sort((a, b) => a - b);
  }

  public setVolume(volume: number): void { this.volume = clampVolume(volume); this.applyGain(); }
  public getVolume(): number { return this.volume; }
  public setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    this.applyGain();
    if (!this.enabled) this.allNotesOff();
  }
  public isEnabled(): boolean { return this.enabled; }
  private applyGain(): void { this.bus.gain.setValueAtTime(this.enabled ? this.volume : 0, this.context.currentTime); }

  public async prepareWindows(plan: AccompanimentPlan, windows: readonly AccompanimentWindow[], signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error("Accompaniment backend has been disposed.");
    if (signal?.aborted) throw abortError();
    validateWindows(windows);
    if (this.prepared?.plan === plan && windows.every((window) => this.prepared!.windows.some((candidate) =>
      window.startSeconds >= candidate.startSeconds && window.endSeconds <= candidate.endSeconds)) && this.isWindowsPrepared(plan, windows)) return;
    this.preparation?.abort();
    const controller = new AbortController();
    this.preparation = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const notes = this.collectNotes(plan, windows);
    try {
      for (const program of notes.keys()) this.getSynth(program);
      // Include empty sets so moving windows release samples for old programs.
      const results = await Promise.allSettled([...this.synths].map(([program, synth]) =>
        synth.prepareNotes(notes.get(program) ?? [], controller.signal)));
      if (controller.signal.aborted || this.disposed || this.preparation !== controller) throw abortError();
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
      this.prepared = { plan, windows: windows.map((window) => ({ ...window })), notes };
    } catch (error) {
      if (!this.disposed && this.preparation === controller) {
        this.prepared = null;
        // A partially successful multi-program window must not retain its leases.
        // A superseding request owns the synths and performs its own replacement.
        await Promise.allSettled([...this.synths.values()].map((synth) => synth.prepareNotes([])));
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.preparation === controller) this.preparation = null;
    }
  }

  public isWindowsPrepared(plan: AccompanimentPlan, windows: readonly AccompanimentWindow[]): boolean {
    if (this.disposed) return false;
    const notes = this.collectNotes(plan, windows);
    if (notes.size === 0) return true;
    const prepared = this.prepared;
    if (!prepared || prepared.plan !== plan || !windows.every((window) => prepared.windows.some((candidate) =>
      window.startSeconds >= candidate.startSeconds && window.endSeconds <= candidate.endSeconds))) return false;
    return [...notes].every(([program, selected]) => this.synths.get(program)?.areNotesPrepared(selected) === true);
  }

  public noteOn(noteId: string, pitch: number, velocity: number, program = 48, scheduledTime?: number): void {
    if (this.disposed || !this.enabled || this.volume <= 0) return;
    const synth = this.getSynth(program);
    if (!synth) {
      // Neither bank has this GM program; never substitute preset zero.
      this.fallback.noteOn(noteId, pitch, velocity, program, scheduledTime);
      return;
    }
    synth.noteOn(pitch, velocity, noteId, scheduledTime);
    this.voices.set(noteId, { synth, pitch });
  }

  public noteOff(noteId: string, scheduledTime?: number): void {
    const voice = this.voices.get(noteId);
    if (voice) voice.synth.noteOff(noteId, voice.pitch, scheduledTime);
    this.voices.delete(noteId);
    this.fallback.noteOff(noteId, scheduledTime);
  }

  public allNotesOff(): void {
    for (const synth of this.synths.values()) synth.silenceAll();
    this.voices.clear();
    this.fallback.allNotesOff();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.preparation?.abort();
    this.preparation = null;
    this.allNotesOff();
    for (const synth of this.synths.values()) synth.dispose();
    this.synths.clear();
    this.fallback.dispose();
    this.bus.disconnect();
    this.prepared = null;
  }

  private resolveProgram(program: number): ProgramRoute | null {
    for (const [source, soundFont] of [
      ["selected", this.options.soundFont], ["builtin", this.options.fallbackSoundFont],
    ] as const) {
      if (!soundFont) continue;
      const presetIndex = soundFont.presets.findIndex((preset) => preset.bankNumber === 0 && preset.presetNumber === program &&
        preset.zones.some((zone) => soundFont.samples[zone.sampleIndex] !== undefined));
      if (presetIndex >= 0) return { soundFont, presetIndex, source };
    }
    return null;
  }

  private getSynth(program: number): SoundFontSynth | null {
    const existing = this.synths.get(program);
    if (existing) return existing;
    const route = this.resolveProgram(program);
    if (!route) return null;
    const synth = new SoundFontSynth({ audioContext: this.context, destinationNode: this.bus, maxPolyphony: this.options.maxPolyphony ?? 32 });
    try {
      synth.loadSoundFont(route.soundFont, route.presetIndex);
    } catch (error) {
      synth.dispose();
      throw error;
    }
    this.synths.set(program, synth);
    return synth;
  }

  private collectNotes(plan: AccompanimentPlan, windows: readonly AccompanimentWindow[]): Map<number, Array<{ pitch: number; velocity: number }>> {
    const grouped = new Map<number, Map<string, { pitch: number; velocity: number }>>();
    for (const note of plan.notes) {
      if (!windows.some((window) => note.endSeconds > window.startSeconds && note.startSeconds <= window.endSeconds) || !this.resolveProgram(note.program)) continue;
      let group = grouped.get(note.program);
      if (!group) { group = new Map(); grouped.set(note.program, group); }
      group.set(`${note.pitch}:${note.velocity}`, { pitch: note.pitch, velocity: note.velocity });
    }
    return new Map([...grouped].map(([program, group]) => [program, [...group.values()]]));
  }
}

function clampVolume(volume: number): number { return Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0)); }
function abortError(): DOMException { return new DOMException("Accompaniment preparation was cancelled.", "AbortError"); }
function validateWindows(windows: readonly AccompanimentWindow[]): void {
  if (windows.some((window) => !Number.isFinite(window.startSeconds) || !Number.isFinite(window.endSeconds) || window.startSeconds < 0 || window.endSeconds < window.startSeconds)) {
    throw new RangeError("Accompaniment preparation windows must have finite, non-negative ordered bounds.");
  }
}
