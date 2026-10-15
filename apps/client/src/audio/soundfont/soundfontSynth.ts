import type { RestoredPianoVoice } from "../sampler.ts";
import type { PedalState } from "../sampler.ts";
import type { Sf2Preset, Sf2SoundFont, SoundFontSynthOptions } from "./types.ts";

const MAX_INACTIVE_DECODED_BYTES = 64 * 1024 * 1024;

interface DecodedSample {
  buffer: AudioBuffer;
  bytes: number;
  lastUse: number;
  pins: number;
}

interface ActiveVoice {
  voiceKey: string;
  noteId: string;
  originalNoteId: string;
  pitch: number;
  velocity: number;
  sampleIndex: number;
  sourceNode: AudioBufferSourceNode;
  gainNode: GainNode;
  panNode?: StereoPannerNode;
  tailSourceNode?: AudioBufferSourceNode;
  startTime: number;
  playbackRate: number;
  loopStartSeconds?: number;
  loopEndSeconds?: number;
  attackSeconds: number;
  peakGain: number;
  releaseSeconds: number;
  keyState: "down" | "up";
  keyReleaseTime?: number;
  releaseStartTime?: number;
  heldBySostenuto: boolean;
  sostenutoCapturedAtBaseline: boolean;
  sustainedByPedal: boolean;
  sampleModes: number;
}

export interface SoundFontPedalState {
  sustain: boolean;
  sostenuto: boolean;
  soft: boolean;
}

/** Polyphonic SF2 sample playback with scheduled notes, pedals, and a bounded decoded cache. */
export class SoundFontSynth {
  private readonly audioContext: AudioContext | OfflineAudioContext;
  private readonly maxPolyphony: number;
  private soundFont: Sf2SoundFont | null = null;
  private activePreset: Sf2Preset | null = null;
  private readonly audioBufferCache = new Map<number, DecodedSample>();
  private readonly activeVoices = new Map<string, ActiveVoice>();
  private pedalEvents: Array<{ controller: 64 | 66 | 67; value: number; time: number }> = [];
  private cachedBytes = 0;
  private cacheClock = 0;
  private pedalState: SoundFontPedalState = { sustain: false, sostenuto: false, soft: false };
  private pedalBaseline: SoundFontPedalState = { sustain: false, sostenuto: false, soft: false };
  private masterGain: GainNode;

  constructor(options: SoundFontSynthOptions) {
    this.audioContext = options.audioContext;
    this.maxPolyphony = options.maxPolyphony ?? 64;
    this.masterGain = this.audioContext.createGain();
    // Output normalization is applied once by the shared master gain downstream.
    this.masterGain.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.masterGain.connect(options.destinationNode ?? this.audioContext.destination);
  }

  public loadSoundFont(sf: Sf2SoundFont, presetIndex = 0): void {
    this.silenceAll();
    this.audioBufferCache.clear();
    this.cachedBytes = 0;
    this.soundFont = sf;
    this.activePreset = sf.presets[presetIndex] ?? sf.presets[0] ?? null;
  }

  public selectPreset(presetNumber: number, bankNumber = 0): boolean {
    if (!this.soundFont) return false;
    const preset = this.soundFont.presets.find((item) => item.presetNumber === presetNumber && item.bankNumber === bankNumber);
    if (!preset) return false;
    this.activePreset = preset;
    return true;
  }

  public noteOn(
    pitch: number,
    velocity: number,
    noteId = `p${pitch}-t${Date.now()}`,
    scheduledTime = this.audioContext.currentTime,
    softPedalAtPress = this.pedalState.soft,
  ): void {
    if (!this.soundFont || !this.activePreset) return;
    const time = Math.max(this.audioContext.currentTime, scheduledTime);
    const effectiveVelocity = softPedalAtPress ? Math.round(velocity * 0.7) : velocity;
    if (effectiveVelocity <= 0) return;
    const zones = this.activePreset.zones.filter((zone) =>
      pitch >= zone.keyRange[0] && pitch <= zone.keyRange[1] &&
      effectiveVelocity >= zone.velRange[0] && effectiveVelocity <= zone.velRange[1]);
    if (!zones.length) return;
    this.enforcePolyphonyLimit(zones.length);

    for (let zoneIndex = 0; zoneIndex < zones.length; zoneIndex++) {
      const zone = zones[zoneIndex]!;
      const sample = this.soundFont.samples[zone.sampleIndex];
      const decoded = this.getOrCreateAudioBuffer(zone.sampleIndex);
      if (!sample || !decoded) continue;
      const source = this.audioContext.createBufferSource();
      source.buffer = decoded.buffer;
      let loopStartSeconds: number | undefined;
      let loopEndSeconds: number | undefined;
      const sampleModes = zone.sampleModes ?? 0;
      if (sampleModes === 1 || sampleModes === 3 || (zone.sampleModes === undefined && sample.loopEnd > sample.loopStart)) {
        const sampleRate = sample.sampleRate || 44100;
        if (sample.loopStart >= sample.start && sample.loopEnd > sample.loopStart && sample.loopEnd <= sample.end) {
          const loopStart = (sample.loopStart - sample.start) / sampleRate;
          const loopEnd = (sample.loopEnd - sample.start) / sampleRate;
          if (loopEnd > loopStart && loopEnd <= decoded.buffer.duration) {
            source.loop = true;
            source.loopStart = loopStart;
            source.loopEnd = loopEnd;
            loopStartSeconds = loopStart;
            loopEndSeconds = loopEnd;
          }
        }
      }
      const rootKey = zone.rootKey ?? sample.originalPitch ?? 60;
      const cents = (pitch - rootKey) * 100 + (zone.pitchCorrection ?? 0);
      const playbackRate = Math.pow(2, cents / 1200);
      source.playbackRate.setValueAtTime(playbackRate, time);

      const gainNode = this.audioContext.createGain();
      const velScale = (effectiveVelocity / 127) ** 1.5;
      const attenuation = Math.pow(10, -(zone.initialAttenuationDb ?? 0) / 200);
      const peakGain = Math.max(0.0001, velScale * 0.5 * attenuation);
      const attack = Math.max(0.003, zone.attackSeconds ?? 0.005);
      const release = Math.max(0.05, zone.releaseSeconds ?? 0.25);
      gainNode.gain.setValueAtTime(0.0001, time);
      gainNode.gain.exponentialRampToValueAtTime(peakGain, time + attack);
      let outputNode: AudioNode = gainNode;
      let panNode: StereoPannerNode | undefined;
      if (zone.pan !== undefined && typeof this.audioContext.createStereoPanner === "function") {
        panNode = this.audioContext.createStereoPanner();
        panNode.pan.setValueAtTime(Math.max(-1, Math.min(1, zone.pan / 500)), time);
        gainNode.connect(panNode);
        outputNode = panNode;
      }
      source.connect(gainNode);
      outputNode.connect(this.masterGain);
      source.start(time);

      const voiceKey = `${noteId}-z${zoneIndex}-${zone.sampleIndex}-${this.cacheClock++}`;
      const voice: ActiveVoice = {
        voiceKey,
        noteId: voiceKey,
        originalNoteId: noteId,
        pitch,
        velocity: effectiveVelocity,
        sampleIndex: zone.sampleIndex,
        sourceNode: source,
        gainNode,
        panNode,
        startTime: time,
        playbackRate,
        loopStartSeconds,
        loopEndSeconds,
        attackSeconds: attack,
        peakGain,
        releaseSeconds: release,
        keyState: "down",
        heldBySostenuto: false,
        sostenutoCapturedAtBaseline: false,
        sustainedByPedal: false,
        sampleModes,
      };
      this.activeVoices.set(voiceKey, voice);
      decoded.pins++;
      this.evictInactiveSamples();
      source.onended = () => {
        if (!voice.tailSourceNode) this.teardownVoice(voiceKey, this.audioContext.currentTime);
      };
    }
  }

  public noteOff(noteIdOrPitch: string | number, pitchOrTime?: number, scheduledTime?: number): void {
    const pitch = typeof noteIdOrPitch === "number" ? noteIdOrPitch : pitchOrTime;
    const time = Math.max(this.audioContext.currentTime, scheduledTime ?? this.audioContext.currentTime);
    for (const voice of this.activeVoices.values()) {
      const matches = typeof noteIdOrPitch === "string"
        ? voice.originalNoteId === noteIdOrPitch || voice.noteId === noteIdOrPitch
        : voice.pitch === pitch;
      if (!matches || voice.keyState !== "down") continue;
      voice.keyState = "up";
      voice.keyReleaseTime = time;
      this.reconcileVoiceHold(voice, time);
    }
  }

  public pedalChange(controller: 64 | 66 | 67, value: number, scheduledTime = this.audioContext.currentTime): void {
    const time = Math.max(this.audioContext.currentTime, scheduledTime);
    const isDown = value >= 64;
    const wasDown = controller === 64 ? this.pedalState.sustain : controller === 66 ? this.pedalState.sostenuto : this.pedalState.soft;
    this.pedalEvents.push({ controller, value, time });
    if (controller === 64) {
      this.pedalState.sustain = isDown;
      if (wasDown && !isDown) {
        for (const voice of this.activeVoices.values()) {
          voice.sustainedByPedal = false;
          this.reconcileVoiceHold(voice, time);
        }
      } else if (!wasDown && isDown) {
        for (const voice of this.activeVoices.values()) {
          if (voice.keyState === "up" && voice.keyReleaseTime !== undefined && voice.keyReleaseTime <= time) {
            voice.sustainedByPedal = true;
          }
        }
      }
    } else if (controller === 66) {
      this.pedalState.sostenuto = isDown;
      if (!wasDown && isDown) {
        for (const voice of this.activeVoices.values()) {
          if (voice.startTime <= time && (voice.keyReleaseTime === undefined || voice.keyReleaseTime > time)) {
            voice.heldBySostenuto = true;
          }
        }
      } else if (wasDown && !isDown) {
        for (const voice of this.activeVoices.values()) {
          if (!voice.heldBySostenuto) continue;
          voice.heldBySostenuto = false;
          this.reconcileVoiceHold(voice, time);
        }
      }
    } else {
      this.pedalState.soft = isDown;
    }
  }

  public setVolume(volume: number): void {
    // Global master volume is owned by the shared audio output chain.
    void volume;
    this.masterGain.gain.setValueAtTime(1, this.audioContext.currentTime);
  }

  public getActiveVoiceCount(): number { return this.activeVoices.size; }
  public getDecodedSampleCacheBytes(): number { return this.cachedBytes; }
  public getPedalState(): Readonly<SoundFontPedalState> {
    const state: SoundFontPedalState = { ...this.pedalBaseline };
    const now = this.audioContext.currentTime;
    for (const event of this.pedalEvents) {
      if (event.time > now) continue;
      const down = event.value >= 64;
      if (event.controller === 64) state.sustain = down;
      else if (event.controller === 66) state.sostenuto = down;
      else state.soft = down;
    }
    return state;
  }
  public getKeyDownNotes(): Array<{ noteId: string; pitch: number }> {
    const result = new Map<string, { noteId: string; pitch: number }>();
    const now = this.audioContext.currentTime;
    for (const voice of this.activeVoices.values()) {
      if (voice.keyState === "down" || (voice.keyReleaseTime !== undefined && voice.keyReleaseTime > now)) {
        result.set(voice.originalNoteId, { noteId: voice.originalNoteId, pitch: voice.pitch });
      }
    }
    return [...result.values()];
  }

  /** Drops only commands after `time`, preserving voices and envelopes already sounding there. */
  public cancelScheduledFutureEvents(time: number): void {
    const now = Math.max(this.audioContext.currentTime, time);
    this.pedalEvents = this.pedalEvents.filter((event) => event.time <= now);
    this.pedalState = { ...this.getPedalState() };

    for (const [key, voice] of [...this.activeVoices]) {
      if (voice.startTime > now) {
        this.teardownVoice(key, now);
        continue;
      }
      if (voice.releaseStartTime !== undefined && voice.releaseStartTime > now) {
        this.cancelVoiceRelease(voice, now);
      }
      if (voice.keyReleaseTime !== undefined && voice.keyReleaseTime > now) {
        voice.keyState = "down";
        voice.keyReleaseTime = undefined;
      }
      voice.heldBySostenuto = this.wasCapturedBySostenuto(voice, now);
      voice.sustainedByPedal = voice.keyState === "up" && this.pedalState.sustain;
      if (voice.keyState === "up") this.reconcileVoiceHold(voice, now);
      else this.restoreLoopWhileHeld(voice);
      voice.sostenutoCapturedAtBaseline = voice.heldBySostenuto;
    }
    this.pedalBaseline = { ...this.pedalState };
    this.pedalEvents = [];
  }

  public restoreState(state: { voices: readonly RestoredPianoVoice[]; pedals: Readonly<PedalState> }): void {
    this.silenceAll();
    this.pedalState = { sustain: false, sostenuto: false, soft: false };
    this.pedalEvents = [];
    const now = this.audioContext.currentTime;
    for (const voice of state.voices) {
      this.noteOn(voice.pitch, voice.velocity, voice.noteId, now, voice.softPedalAtPress);
      for (const active of this.activeVoices.values()) {
        if (active.originalNoteId !== voice.noteId) continue;
        active.keyState = voice.keyState;
        active.heldBySostenuto = voice.heldBySostenuto;
        active.sostenutoCapturedAtBaseline = voice.heldBySostenuto;
        active.sustainedByPedal = voice.sustainedBySustain;
        if (voice.keyState === "up" && !voice.heldBySostenuto && !voice.sustainedBySustain) {
          active.keyReleaseTime = now;
          this.startVoiceRelease(active, now);
        }
      }
    }
    this.pedalState = { ...state.pedals };
    this.pedalBaseline = { ...state.pedals };
  }

  public silenceAll(): void {
    const now = this.audioContext.currentTime;
    for (const voice of [...this.activeVoices.values()]) this.teardownVoice(voice.voiceKey, now);
    this.pedalEvents = [];
    this.pedalState = { sustain: false, sostenuto: false, soft: false };
    this.pedalBaseline = { sustain: false, sostenuto: false, soft: false };
  }

  public dispose(): void {
    this.silenceAll();
    this.audioBufferCache.clear();
    this.cachedBytes = 0;
    this.masterGain.disconnect();
  }

  private reconcileVoiceHold(voice: ActiveVoice, time: number): void {
    if (voice.keyState === "down") return;
    voice.sustainedByPedal = this.pedalState.sustain;
    if (!voice.sustainedByPedal && !voice.heldBySostenuto) this.startVoiceRelease(voice, time);
  }

  private startVoiceRelease(voice: ActiveVoice, time: number): void {
    if (voice.releaseStartTime !== undefined && voice.releaseStartTime <= time) return;
    voice.releaseStartTime = time;
    if (voice.sampleModes === 3) this.scheduleMode3Tail(voice, time);
    try {
      const gain = voice.gainNode.gain;
      const atStart = Math.max(0.0001, this.envelopeGainAt(voice, time));
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(atStart, time);
      gain.exponentialRampToValueAtTime(0.0001, time + voice.releaseSeconds);
      if (voice.tailSourceNode) voice.tailSourceNode.stop(time + voice.releaseSeconds + 0.05);
      else if (voice.sampleModes !== 3) voice.sourceNode.stop(time + voice.releaseSeconds + 0.05);
    } catch { /* Web Audio may reject a stop on an ended voice. */ }
  }

  private cancelVoiceRelease(voice: ActiveVoice, time: number): void {
    voice.releaseStartTime = undefined;
    if (voice.tailSourceNode) {
      const tail = voice.tailSourceNode;
      voice.tailSourceNode = undefined;
      tail.onended = null;
      try {
        tail.stop(time);
        tail.disconnect();
      } catch { /* Ignore a tail that already ended. */ }
    }
    const gain = voice.gainNode.gain;
    const value = Math.max(0.0001, this.envelopeGainAt(voice, time));
    try {
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(value, time);
      if (time < voice.startTime + voice.attackSeconds) {
        gain.exponentialRampToValueAtTime(voice.peakGain, voice.startTime + voice.attackSeconds);
      }
      const source = voice.sourceNode as AudioBufferSourceNode & { stop: (when?: number) => void };
      // A later stop() replaces an earlier scheduled stop; push it beyond the
      // Web Audio session so a canceled future release cannot truncate a held loop.
      source.stop(time + 24 * 60 * 60);
      if (voice.sampleModes === 3 && voice.loopStartSeconds !== undefined) source.loop = true;
    } catch { /* Keep the active envelope if a browser rejects rescheduling. */ }
  }

  private envelopeGainAt(voice: ActiveVoice, time: number): number {
    const attackEnd = voice.startTime + voice.attackSeconds;
    if (time <= voice.startTime) return 0.0001;
    if (time < attackEnd) {
      const ratio = (time - voice.startTime) / voice.attackSeconds;
      return 0.0001 * Math.pow(voice.peakGain / 0.0001, Math.max(0, ratio));
    }
    if (voice.releaseStartTime !== undefined && time >= voice.releaseStartTime) {
      const releaseRatio = Math.min(1, (time - voice.releaseStartTime) / voice.releaseSeconds);
      const start = Math.max(0.0001, this.envelopeGainAt({ ...voice, releaseStartTime: undefined }, voice.releaseStartTime));
      return start * Math.pow(0.0001 / start, releaseRatio);
    }
    return voice.peakGain;
  }

  private wasCapturedBySostenuto(voice: ActiveVoice, time: number): boolean {
    let sostenuto = this.pedalBaseline.sostenuto;
    let captured = voice.sostenutoCapturedAtBaseline;
    for (const event of this.pedalEvents) {
      if (event.time > time) break;
      if (event.controller !== 66) continue;
      const down = event.value >= 64;
      if (!sostenuto && down && voice.startTime <= event.time &&
          (voice.keyReleaseTime === undefined || voice.keyReleaseTime > event.time)) captured = true;
      if (sostenuto && !down) captured = false;
      sostenuto = down;
    }
    return captured && sostenuto;
  }

  private restoreLoopWhileHeld(voice: ActiveVoice): void {
    if (voice.sampleModes === 3 && voice.releaseStartTime === undefined) {
      if (voice.loopStartSeconds !== undefined) voice.sourceNode.loop = true;
    }
  }

  private scheduleMode3Tail(voice: ActiveVoice, time: number): void {
    const { loopStartSeconds, loopEndSeconds, playbackRate, sourceNode } = voice;
    if (!sourceNode.loop || loopStartSeconds === undefined || loopEndSeconds === undefined || !sourceNode.buffer) return;
    const loopDuration = loopEndSeconds - loopStartSeconds;
    const firstLoopTime = voice.startTime + loopEndSeconds / playbackRate;
    const elapsed = Math.max(0, time - voice.startTime);
    const offset = time < firstLoopTime
      ? elapsed * playbackRate
      : loopStartSeconds + (((time - firstLoopTime) * playbackRate) % loopDuration);
    const tail = this.audioContext.createBufferSource();
    tail.buffer = sourceNode.buffer;
    tail.playbackRate.setValueAtTime(playbackRate, time);
    tail.connect(voice.gainNode);
    const tailSampleRate = tail.buffer.sampleRate || 44100;
    tail.start(time, Math.min(offset, Math.max(0, tail.buffer.duration - 1 / tailSampleRate)));
    voice.tailSourceNode = tail;
    tail.onended = () => {
      if (voice.tailSourceNode === tail) this.teardownVoice(voice.voiceKey, this.audioContext.currentTime);
    };
    try {
      // The main loop stops exactly when the one-shot loop tail begins.
      sourceNode.stop(time);
    } catch { /* Ignore already-stopped sources. */ }
  }

  private enforcePolyphonyLimit(incomingVoices: number): void {
    while (this.activeVoices.size + incomingVoices > this.maxPolyphony) {
      const candidate = [...this.activeVoices.values()].sort((a, b) => {
        const aReleased = a.releaseStartTime !== undefined ? 0 : 1;
        const bReleased = b.releaseStartTime !== undefined ? 0 : 1;
        return aReleased - bReleased || a.startTime - b.startTime;
      })[0];
      if (!candidate) break;
      this.teardownVoice(candidate.voiceKey, this.audioContext.currentTime);
    }
  }

  private teardownVoice(key: string, time: number): void {
    const voice = this.activeVoices.get(key);
    if (!voice) return;
    try {
      voice.gainNode.gain.cancelScheduledValues(time);
      voice.gainNode.gain.setValueAtTime(0.0001, time);
      voice.sourceNode.stop(time);
      voice.tailSourceNode?.stop(time);
      voice.sourceNode.disconnect();
      voice.gainNode.disconnect();
      voice.panNode?.disconnect();
    } catch { /* Ignore already-ended nodes. */ }
    this.activeVoices.delete(key);
    const cached = this.audioBufferCache.get(voice.sampleIndex);
    if (cached) {
      cached.pins = Math.max(0, cached.pins - 1);
      this.evictInactiveSamples();
    }
  }

  private getOrCreateAudioBuffer(sampleIndex: number): DecodedSample | null {
    const cached = this.audioBufferCache.get(sampleIndex);
    if (cached) {
      cached.lastUse = ++this.cacheClock;
      return cached;
    }
    if (!this.soundFont?.rawSampleData) return null;
    const sample = this.soundFont.samples[sampleIndex];
    if (!sample) return null;
    const length = Math.max(1, Math.min(sample.end - sample.start, this.soundFont.rawSampleData.length - sample.start));
    if (!Number.isFinite(length) || length <= 0) return null;
    const buffer = this.audioContext.createBuffer(1, length, sample.sampleRate || 44100);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < length; index++) channel[index] = (this.soundFont.rawSampleData[sample.start + index] ?? 0) / 32768;
    const entry = { buffer, bytes: length * 4, lastUse: ++this.cacheClock, pins: 0 };
    this.audioBufferCache.set(sampleIndex, entry);
    this.cachedBytes += entry.bytes;
    return entry;
  }

  private evictInactiveSamples(): void {
    while (this.cachedBytes > MAX_INACTIVE_DECODED_BYTES) {
      const victim = [...this.audioBufferCache.entries()]
        .filter(([, sample]) => sample.pins === 0)
        .sort((a, b) => a[1].lastUse - b[1].lastUse)[0];
      if (!victim) return;
      this.audioBufferCache.delete(victim[0]);
      this.cachedBytes -= victim[1].bytes;
    }
  }
}
