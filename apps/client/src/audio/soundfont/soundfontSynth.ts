import type { Sf2Preset, Sf2SoundFont, SoundFontSynthOptions } from "./types";

interface ActiveVoice {
  noteId: string;
  pitch: number;
  velocity: number;
  sourceNode: AudioBufferSourceNode;
  gainNode: GainNode;
  panNode?: StereoPannerNode;
  startTime: number;
  releaseSeconds: number;
  keyState: "down" | "up";
  sustainedByPedal: boolean;
  heldBySostenuto: boolean;
}

export interface SoundFontPedalState {
  sustain: boolean;
  sostenuto: boolean;
  soft: boolean;
}

/**
 * Polyphonic Web Audio SoundFont 2 synthesizer.
 * Supports realistic acoustic instrument samples, multi-velocity zones,
 * stereo panning, volume envelopes, and pedal physics matching ADR-001.
 */
export class SoundFontSynth {
  private readonly audioContext: AudioContext;
  private readonly destinationNode: AudioNode;
  private readonly maxPolyphony: number;
  private soundFont: Sf2SoundFont | null = null;
  private activePreset: Sf2Preset | null = null;

  private readonly audioBufferCache = new Map<number, AudioBuffer>();
  private readonly activeVoices = new Map<string, ActiveVoice>();

  private pedalState: SoundFontPedalState = {
    sustain: false,
    sostenuto: false,
    soft: false,
  };

  private masterGain: GainNode;

  constructor(options: SoundFontSynthOptions) {
    this.audioContext = options.audioContext;
    this.maxPolyphony = options.maxPolyphony ?? 64;
    this.masterGain = this.audioContext.createGain();
    this.masterGain.gain.setValueAtTime(0.8, this.audioContext.currentTime);

    this.destinationNode = options.destinationNode ?? this.audioContext.destination;
    this.masterGain.connect(this.destinationNode);
  }

  /**
   * Loads and attaches an SF2 SoundFont.
   */
  public loadSoundFont(sf: Sf2SoundFont, presetIndex = 0): void {
    this.silenceAll();
    this.audioBufferCache.clear();
    this.soundFont = sf;

    if (sf.presets.length > 0) {
      this.activePreset = sf.presets[presetIndex] ?? sf.presets[0]!;
    } else {
      this.activePreset = null;
    }
  }

  /**
   * Selects an active preset by preset number and bank number.
   */
  public selectPreset(presetNumber: number, bankNumber = 0): boolean {
    if (!this.soundFont) return false;
    const found = this.soundFont.presets.find(
      (p) => p.presetNumber === presetNumber && p.bankNumber === bankNumber,
    );
    if (found) {
      this.activePreset = found;
      return true;
    }
    return false;
  }

  /**
   * Starts playing a note given its MIDI pitch [21..108] and velocity [1..127].
   */
  public noteOn(pitch: number, velocity: number, noteId = `p${pitch}-t${Date.now()}`): void {
    if (!this.soundFont || !this.activePreset) return;

    // Apply soft pedal scaling
    const effectiveVel = this.pedalState.soft ? Math.round(velocity * 0.7) : velocity;
    if (effectiveVel <= 0) return;

    // Find all matching zones for this pitch and velocity
    const matchingZones = this.activePreset.zones.filter(
      (z) =>
        pitch >= z.keyRange[0] &&
        pitch <= z.keyRange[1] &&
        effectiveVel >= z.velRange[0] &&
        effectiveVel <= z.velRange[1],
    );

    if (matchingZones.length === 0) return;

    this.enforcePolyphonyLimit();

    const now = this.audioContext.currentTime;

    for (const zone of matchingZones) {
      const audioBuffer = this.getOrCreateAudioBuffer(zone.sampleIndex);
      if (!audioBuffer) continue;

      const sourceNode = this.audioContext.createBufferSource();
      sourceNode.buffer = audioBuffer;

      // Calculate playback rate for pitch transposition
      const rootKey = zone.rootKey ?? 60;
      const correctionCents = zone.pitchCorrection ?? 0;
      const totalCents = (pitch - rootKey) * 100 + correctionCents;
      const playbackRate = Math.pow(2, totalCents / 1200);
      sourceNode.playbackRate.setValueAtTime(playbackRate, now);

      // Volume envelope gain
      const gainNode = this.audioContext.createGain();
      const velScale = (effectiveVel / 127) ** 1.5;
      const peakGain = Math.max(0.001, velScale * 0.5);

      const attack = Math.max(0.003, zone.attackSeconds ?? 0.005);
      const release = Math.max(0.05, zone.releaseSeconds ?? 0.25);

      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(peakGain, now + attack);

      // Optional stereo pan
      let outputNode: AudioNode = gainNode;
      let panNode: StereoPannerNode | undefined;
      if (zone.pan !== undefined && typeof this.audioContext.createStereoPanner === "function") {
        panNode = this.audioContext.createStereoPanner();
        panNode.pan.setValueAtTime(Math.max(-1, Math.min(1, zone.pan / 500)), now);
        gainNode.connect(panNode);
        outputNode = panNode;
      }

      outputNode.connect(this.masterGain);
      sourceNode.connect(gainNode);

      sourceNode.start(now);

      const voiceKey = `${noteId}-${zone.sampleIndex}`;
      const voice: ActiveVoice = {
        noteId: voiceKey,
        pitch,
        velocity: effectiveVel,
        sourceNode,
        gainNode,
        panNode,
        startTime: now,
        releaseSeconds: release,
        keyState: "down",
        sustainedByPedal: this.pedalState.sustain,
        heldBySostenuto: this.pedalState.sostenuto,
      };

      this.activeVoices.set(voiceKey, voice);

      sourceNode.onended = () => {
        this.teardownVoice(voiceKey);
      };
    }
  }

  /**
   * Releases a note.
   */
  public noteOff(pitch: number): void {
    const now = this.audioContext.currentTime;

    for (const voice of this.activeVoices.values()) {
      if (voice.pitch === pitch && voice.keyState === "down") {
        voice.keyState = "up";
        if (this.pedalState.sustain) {
          voice.sustainedByPedal = true;
          continue;
        }
        if (voice.heldBySostenuto) {
          continue;
        }
        this.startVoiceRelease(voice, now);
      }
    }
  }

  /**
   * Updates pedal state (CC 64, 66, 67).
   */
  public pedalChange(controller: 64 | 66 | 67, value: number): void {
    const isDown = value >= 64;
    const now = this.audioContext.currentTime;

    if (controller === 64) {
      this.pedalState.sustain = isDown;
      if (!isDown) {
        // Release all voices that were held by sustain
        for (const voice of this.activeVoices.values()) {
          if (voice.sustainedByPedal && voice.keyState === "up" && !voice.heldBySostenuto) {
            voice.sustainedByPedal = false;
            this.startVoiceRelease(voice, now);
          }
        }
      }
    } else if (controller === 66) {
      this.pedalState.sostenuto = isDown;
      if (isDown) {
        // Hold currently depressed keys
        for (const voice of this.activeVoices.values()) {
          if (voice.keyState === "down") {
            voice.heldBySostenuto = true;
          }
        }
      } else {
        // Lift sostenuto
        for (const voice of this.activeVoices.values()) {
          if (voice.heldBySostenuto) {
            voice.heldBySostenuto = false;
            if (voice.keyState === "up" && !this.pedalState.sustain) {
              this.startVoiceRelease(voice, now);
            }
          }
        }
      }
    } else if (controller === 67) {
      this.pedalState.soft = isDown;
    }
  }

  /**
   * Sets master synth volume (0..1).
   */
  public setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.masterGain.gain.setValueAtTime(clamped, this.audioContext.currentTime);
  }

  /**
   * Immediately stops and cleans up all active voices.
   */
  public silenceAll(): void {
    const now = this.audioContext.currentTime;
    for (const voice of this.activeVoices.values()) {
      try {
        voice.gainNode.gain.cancelScheduledValues(now);
        voice.gainNode.gain.setValueAtTime(0.0001, now);
        voice.sourceNode.stop(now);
        voice.sourceNode.disconnect();
        voice.gainNode.disconnect();
        voice.panNode?.disconnect();
      } catch {
        // Ignore
      }
    }
    this.activeVoices.clear();
  }

  public getActiveVoiceCount(): number {
    return this.activeVoices.size;
  }

  public getPedalState(): Readonly<SoundFontPedalState> {
    return { ...this.pedalState };
  }

  public dispose(): void {
    this.silenceAll();
    this.audioBufferCache.clear();
    this.masterGain.disconnect();
  }

  private startVoiceRelease(voice: ActiveVoice, time: number): void {
    try {
      const currentGain = Math.max(0.001, voice.gainNode.gain.value);
      voice.gainNode.gain.cancelScheduledValues(time);
      voice.gainNode.gain.setValueAtTime(currentGain, time);
      voice.gainNode.gain.exponentialRampToValueAtTime(0.0001, time + voice.releaseSeconds);
      voice.sourceNode.stop(time + voice.releaseSeconds + 0.05);
    } catch {
      // Ignore
    }
  }

  private enforcePolyphonyLimit(): void {
    if (this.activeVoices.size < this.maxPolyphony) return;

    // Steal oldest released voice or oldest sounding voice
    let oldestVoiceKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, voice] of this.activeVoices.entries()) {
      if (voice.keyState === "up" && voice.startTime < oldestTime) {
        oldestTime = voice.startTime;
        oldestVoiceKey = key;
      }
    }

    if (!oldestVoiceKey) {
      for (const [key, voice] of this.activeVoices.entries()) {
        if (voice.startTime < oldestTime) {
          oldestTime = voice.startTime;
          oldestVoiceKey = key;
        }
      }
    }

    if (oldestVoiceKey) {
      this.teardownVoice(oldestVoiceKey);
    }
  }

  private teardownVoice(key: string): void {
    const voice = this.activeVoices.get(key);
    if (!voice) return;
    try {
      voice.sourceNode.disconnect();
      voice.gainNode.disconnect();
      voice.panNode?.disconnect();
    } catch {
      // Ignore
    }
    this.activeVoices.delete(key);
  }

  private getOrCreateAudioBuffer(sampleIndex: number): AudioBuffer | null {
    if (this.audioBufferCache.has(sampleIndex)) {
      return this.audioBufferCache.get(sampleIndex)!;
    }

    if (!this.soundFont || !this.soundFont.rawSampleData) return null;
    const sample = this.soundFont.samples[sampleIndex];
    if (!sample) return null;

    const length = Math.max(1, sample.end - sample.start);
    const audioBuffer = this.audioContext.createBuffer(
      1,
      length,
      sample.sampleRate || 44100,
    );

    const channelData = audioBuffer.getChannelData(0);
    const rawData = this.soundFont.rawSampleData;
    const offset = sample.start;

    for (let i = 0; i < length; i++) {
      channelData[i] = (rawData[offset + i] ?? 0) / 32768.0;
    }

    this.audioBufferCache.set(sampleIndex, audioBuffer);
    return audioBuffer;
  }
}
