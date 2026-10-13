import { getAudioContext, getMasterGain } from "./audioContext.ts";

/**
 * Voice state tracked inside the polyphonic piano synthesizer.
 */
interface ActiveVoice {
  noteId: string;
  pitch: number;
  velocity: number;
  effectiveVelocity: number;
  startTime: number;
  peakGain: number;
  decayTime: number;
  releaseTime: number;
  keyState: "down" | "up";
  sustainedBySustain: boolean;
  heldBySostenuto: boolean;
  released: boolean;

  oscillators: OscillatorNode[];
  voiceGain: GainNode;
  filter: BiquadFilterNode;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface PedalState {
  sustain: boolean;
  sostenuto: boolean;
  soft: boolean;
}

export interface RestoredPianoVoice {
  noteId: string;
  pitch: number;
  velocity: number;
  keyState: "down" | "up";
  heldBySostenuto: boolean;
  sustainedBySustain: boolean;
  softPedalAtPress: boolean;
}

export interface PianoSamplerRestoreState {
  voices: readonly RestoredPianoVoice[];
  pedals: Readonly<PedalState>;
}

export type PianoTimbre = "acoustic" | "bright" | "warm";

export interface PianoSamplerOptions {
  audioContext?: AudioContext;
  destinationNode?: AudioNode;
  maxPolyphony?: number;
}

const DEFAULT_MAX_POLYPHONY = 64;
const NUM_PIANO_PARTIALS = 16;
const ATTACK_SECONDS = 0.003;
const RELEASE_FADE_SECONDS = 0.005;

/**
 * Polyphonic Web Audio piano synthesizer reproducing acoustic tone
 * with harmonic partials, velocity scaling, and full pedal support
 * matching ADR-001 (Sustain CC 64, Sostenuto CC 66, Soft CC 67).
 */
export class PianoSampler {
  private readonly audioContext: AudioContext;
  private readonly destinationNode: AudioNode;
  private readonly maxPolyphony: number;
  private timbre: PianoTimbre = "acoustic";

  private readonly activeVoices = new Map<string, ActiveVoice>();
  private readonly pedalState: PedalState = {
    sustain: false,
    sostenuto: false,
    soft: false,
  };

  private periodicWave: PeriodicWave | null = null;

  constructor(options: PianoSamplerOptions = {}) {
    this.audioContext = options.audioContext ?? getAudioContext();
    this.destinationNode = options.destinationNode ?? (options.audioContext ? options.audioContext.destination : getMasterGain());
    this.maxPolyphony = options.maxPolyphony ?? DEFAULT_MAX_POLYPHONY;

    this.initPeriodicWave();
  }

  /**
   * Initializes Fourier series for acoustic piano partials.
   */
  private initPeriodicWave(): void {
    if (typeof this.audioContext.createPeriodicWave !== "function") {
      return;
    }
    const real = new Float32Array(NUM_PIANO_PARTIALS);
    const imag = new Float32Array(NUM_PIANO_PARTIALS);

    // DC offset is 0
    real[0] = 0;
    imag[0] = 0;

    const profile = this.timbre === "bright"
      ? { exponent: 0.9, rolloff: 0.035 }
      : this.timbre === "warm"
        ? { exponent: 1.35, rolloff: 0.1 }
        : { exponent: 1.15, rolloff: 0.06 };

    // Change harmonic rolloff for new voices while existing voices retain their wave.
    for (let n = 1; n < NUM_PIANO_PARTIALS; n += 1) {
      real[n] = 0;
      imag[n] = (1 / Math.pow(n, profile.exponent)) * Math.exp(-profile.rolloff * n);
    }

    try {
      this.periodicWave = this.audioContext.createPeriodicWave(real, imag, {
        disableNormalization: false,
      });
    } catch {
      this.periodicWave = null;
    }
  }

  /**
   * Converts MIDI pitch [21..108] to frequency in Hertz.
   */
  public static pitchToFrequency(pitch: number): number {
    return 440 * Math.pow(2, (pitch - 69) / 12);
  }

  /** Changes the tone of newly created notes without disturbing sounding voices. */
  public setTimbre(timbre: PianoTimbre): void {
    if (timbre === this.timbre) return;
    this.timbre = timbre;
    this.initPeriodicWave();
  }

  public getTimbre(): PianoTimbre {
    return this.timbre;
  }

  /**
   * Triggers note strike from PerformancePlan.
   *
   * @param noteId Unique note identifier
   * @param pitch MIDI pitch (21..108)
   * @param velocity Note velocity (1..127)
   * @param scheduledTime Web Audio AudioContext time in seconds
   */
  public noteOn(noteId: string, pitch: number, velocity: number, scheduledTime?: number): void {
    const now = this.audioContext.currentTime;
    const startTime = Math.max(now, scheduledTime ?? now);

    // If a voice with this noteId is already sounding, choke it first
    if (this.activeVoices.has(noteId)) {
      this.forceStopVoice(noteId, startTime);
    }

    // Polyphony voice stealing if limit reached
    if (this.activeVoices.size >= this.maxPolyphony) {
      this.stealVoice(startTime);
    }

    // Soft pedal (CC 67): reduces velocity to 0.7x
    const effectiveVelocity = this.pedalState.soft
      ? Math.max(1, Math.min(127, Math.round(velocity * 0.7)))
      : Math.max(1, Math.min(127, velocity));

    const frequency = PianoSampler.pitchToFrequency(pitch);
    const normPitch = Math.max(0, Math.min(1, (pitch - 21) / (108 - 21)));
    const normalizedVel = effectiveVelocity / 127;

    // Perceived acoustic loudness follows exponential power curve
    const peakGain = Math.max(0.001, Math.pow(normalizedVel, 1.8) * 0.28);

    // Natural decay time constant: bass notes (~8s) ring much longer than treble (~1.2s)
    const decayTime = Math.max(0.6, 8.0 * (1.0 - normPitch * 0.85));
    // Release damper time constant: ~120ms bass, ~60ms treble
    const releaseTime = Math.max(0.04, 0.12 * (1.0 - normPitch * 0.5));

    // Dynamic Lowpass Filter: felt hammer strike is brighter at high velocity
    const filter = this.audioContext.createBiquadFilter();
    filter.type = "lowpass";
    const velocityBrightness = this.timbre === "bright" ? 9.5 : this.timbre === "warm" ? 5.5 : 7.5;
    const baseCutoff = Math.min(16000, frequency * (3.5 + normalizedVel * velocityBrightness) + 400);
    filter.frequency.setValueAtTime(baseCutoff * 1.4, startTime);
    filter.frequency.exponentialRampToValueAtTime(baseCutoff, startTime + 0.035);
    filter.frequency.setTargetAtTime(Math.min(baseCutoff * 0.5, 3500), startTime + 0.035, decayTime);
    filter.Q.setValueAtTime(1.2, startTime);

    // Voice Gain Envelope
    const voiceGain = this.audioContext.createGain();
    voiceGain.gain.setValueAtTime(0.0001, startTime);
    voiceGain.gain.exponentialRampToValueAtTime(peakGain, startTime + ATTACK_SECONDS);
    voiceGain.gain.setTargetAtTime(0.0001, startTime + ATTACK_SECONDS, decayTime);

    // Layered unison oscillators (chorused by ±1.8 cents for natural acoustic shimmer)
    const oscillators: OscillatorNode[] = [];
    const detuneOffsets = [-1.8, 1.8];

    for (const detune of detuneOffsets) {
      const osc = this.audioContext.createOscillator();
      if (this.periodicWave) {
        osc.setPeriodicWave(this.periodicWave);
      } else {
        osc.type = "triangle";
      }
      osc.frequency.setValueAtTime(frequency, startTime);
      osc.detune.setValueAtTime(detune, startTime);
      osc.connect(filter);
      try {
        osc.start(startTime);
      } catch {
        // Fallback for mocks
      }
      oscillators.push(osc);
    }

    filter.connect(voiceGain);
    voiceGain.connect(this.destinationNode);

    const voice: ActiveVoice = {
      noteId,
      pitch,
      velocity,
      effectiveVelocity,
      startTime,
      peakGain,
      decayTime,
      releaseTime,
      keyState: "down",
      sustainedBySustain: false,
      heldBySostenuto: false,
      released: false,
      oscillators,
      voiceGain,
      filter,
    };

    // Auto-cleanup timer after natural decay completes (-80dB drop)
    const autoCleanupDelayMs = Math.round((decayTime * 4.5 + 1.0) * 1000);
    voice.cleanupTimer = setTimeout(() => {
      if (this.activeVoices.get(noteId) === voice) {
        this.forceStopVoice(noteId, this.audioContext.currentTime);
      }
    }, autoCleanupDelayMs);

    this.activeVoices.set(noteId, voice);
  }

  /**
   * Triggers key release for a note.
   *
   * @param noteId Unique note identifier
   * @param scheduledTime Web Audio AudioContext time in seconds
   */
  public noteOff(noteId: string, scheduledTime?: number): void {
    const voice = this.activeVoices.get(noteId);
    if (!voice) {
      return;
    }

    voice.keyState = "up";
    const now = this.audioContext.currentTime;
    const releaseTimePoint = Math.max(now, scheduledTime ?? now);

    // If sustain pedal is currently active, voice continues ringing
    if (this.pedalState.sustain) {
      voice.sustainedBySustain = true;
      return;
    }

    // If sostenuto pedal captured this voice, voice continues ringing
    if (voice.heldBySostenuto && this.pedalState.sostenuto) {
      return;
    }

    // Otherwise damper applies
    this.scheduleVoiceRelease(voice, releaseTimePoint);
  }

  /**
   * Applies damper release envelope to a voice.
   */
  private scheduleVoiceRelease(voice: ActiveVoice, releaseTimePoint: number): void {
    if (voice.released) {
      return;
    }
    voice.released = true;

    // Estimate current gain from decay curve to avoid clicks upon release
    const elapsedSinceAttack = Math.max(0, releaseTimePoint - (voice.startTime + ATTACK_SECONDS));
    const currentGainEstimate = Math.max(
      0.0001,
      voice.peakGain * Math.exp(-elapsedSinceAttack / voice.decayTime),
    );

    try {
      voice.voiceGain.gain.cancelScheduledValues(releaseTimePoint);
      voice.voiceGain.gain.setValueAtTime(currentGainEstimate, releaseTimePoint);
      voice.voiceGain.gain.exponentialRampToValueAtTime(
        0.0001,
        releaseTimePoint + voice.releaseTime,
      );
    } catch {
      // Ignore if AudioParam is unavailable
    }

    const stopTime = releaseTimePoint + voice.releaseTime + 0.03;
    for (const osc of voice.oscillators) {
      try {
        osc.stop(stopTime);
      } catch {
        // Ignore if already stopped
      }
    }

    // Schedule cleanup
    const cleanupDelayMs = Math.max(
      20,
      Math.round((stopTime - this.audioContext.currentTime + 0.05) * 1000),
    );
    if (voice.cleanupTimer) {
      clearTimeout(voice.cleanupTimer);
    }
    voice.cleanupTimer = setTimeout(() => {
      this.teardownVoice(voice);
    }, cleanupDelayMs);
  }

  /**
   * Processes MIDI pedal controllers matching ADR-001 / PerformancePlan:
   * - CC 64: Sustain
   * - CC 66: Sostenuto
   * - CC 67: Soft
   *
   * @param controller 64 | 66 | 67
   * @param value 0..127 (values >= 64 engage pedal, < 64 disengage)
   * @param scheduledTime Web Audio AudioContext time in seconds
   */
  public pedal(controller: 64 | 66 | 67, value: number, scheduledTime?: number): void {
    const isEngaged = value >= 64;
    const now = this.audioContext.currentTime;
    const eventTime = Math.max(now, scheduledTime ?? now);

    if (controller === 64) {
      // Sustain pedal (CC 64)
      const wasEngaged = this.pedalState.sustain;
      this.pedalState.sustain = isEngaged;

      if (wasEngaged && !isEngaged) {
        // Sustain released: release all voices whose keys were already released
        for (const voice of this.activeVoices.values()) {
          if (voice.keyState === "up" && !voice.released) {
            // If sostenuto holds it, keep ringing
            if (voice.heldBySostenuto && this.pedalState.sostenuto) {
              continue;
            }
            voice.sustainedBySustain = false;
            this.scheduleVoiceRelease(voice, eventTime);
          }
        }
      }
    } else if (controller === 66) {
      // Sostenuto pedal (CC 66)
      const wasEngaged = this.pedalState.sostenuto;
      this.pedalState.sostenuto = isEngaged;

      if (!wasEngaged && isEngaged) {
        // Sostenuto engaged: capture all voices whose keys are currently pressed down
        for (const voice of this.activeVoices.values()) {
          if (voice.keyState === "down") {
            voice.heldBySostenuto = true;
          }
        }
      } else if (wasEngaged && !isEngaged) {
        // Sostenuto released: release captured voices whose keys are up
        for (const voice of this.activeVoices.values()) {
          if (voice.heldBySostenuto) {
            voice.heldBySostenuto = false;
            if (voice.keyState === "up" && !voice.released) {
              if (this.pedalState.sustain) {
                voice.sustainedBySustain = true;
                continue;
              }
              this.scheduleVoiceRelease(voice, eventTime);
            }
          }
        }
      }
    } else if (controller === 67) {
      // Soft pedal (CC 67): reduces velocity to 0.7x for subsequent notes
      this.pedalState.soft = isEngaged;
    }
  }

  /**
   * Instantly chokes all active voices and resets pedal states (used on stop or seek).
   */
  public silenceAll(): void {
    const now = this.audioContext.currentTime;
    for (const voice of this.activeVoices.values()) {
      if (voice.cleanupTimer) {
        clearTimeout(voice.cleanupTimer);
      }
      try {
        voice.voiceGain.gain.cancelScheduledValues(now);
        voice.voiceGain.gain.setValueAtTime(voice.voiceGain.gain.value, now);
        voice.voiceGain.gain.linearRampToValueAtTime(0, now + RELEASE_FADE_SECONDS);
        for (const osc of voice.oscillators) {
          osc.stop(now + RELEASE_FADE_SECONDS);
        }
      } catch {
        // Ignore audio errors during quick silence
      }
      setTimeout(() => {
        try {
          voice.voiceGain.disconnect();
          voice.filter.disconnect();
        } catch {
          // Ignore disconnection errors
        }
      }, 15);
    }

    this.activeVoices.clear();
    this.pedalState.sustain = false;
    this.pedalState.sostenuto = false;
    this.pedalState.soft = false;
  }

  /**
   * Steals a voice when polyphony limit is exceeded, preferring released voices.
   */
  private stealVoice(time: number): void {
    let candidateVoice: ActiveVoice | null = null;

    // First search for oldest released voice
    for (const voice of this.activeVoices.values()) {
      if (voice.keyState === "up" || voice.released) {
        if (!candidateVoice || voice.startTime < candidateVoice.startTime) {
          candidateVoice = voice;
        }
      }
    }

    // Otherwise steal the oldest sounding voice
    if (!candidateVoice) {
      for (const voice of this.activeVoices.values()) {
        if (!candidateVoice || voice.startTime < candidateVoice.startTime) {
          candidateVoice = voice;
        }
      }
    }

    if (candidateVoice) {
      this.forceStopVoice(candidateVoice.noteId, time);
    }
  }

  /**
   * Immediately stops and disconnects a voice.
   */
  private forceStopVoice(noteId: string, time: number): void {
    const voice = this.activeVoices.get(noteId);
    if (!voice) {
      return;
    }
    if (voice.cleanupTimer) {
      clearTimeout(voice.cleanupTimer);
    }
    try {
      voice.voiceGain.gain.cancelScheduledValues(time);
      voice.voiceGain.gain.setValueAtTime(0.0001, time);
      for (const osc of voice.oscillators) {
        osc.stop(time);
      }
    } catch {
      // Ignore
    }
    this.teardownVoice(voice);
  }

  /**
   * Disconnects nodes and unregisters voice.
   */
  private teardownVoice(voice: ActiveVoice): void {
    try {
      voice.voiceGain.disconnect();
      voice.filter.disconnect();
    } catch {
      // Ignore
    }
    if (this.activeVoices.get(voice.noteId) === voice) {
      this.activeVoices.delete(voice.noteId);
    }
  }

  /**
   * Returns count of currently active voices.
   */
  public getActiveVoiceCount(): number {
    return this.activeVoices.size;
  }

  /**
   * Returns the current pedal states.
   */
  public getPedalState(): Readonly<PedalState> {
    return { ...this.pedalState };
  }

  /** Restores only currently sounding voices and their exact pedal relationships. */
  public restoreState(state: PianoSamplerRestoreState): void {
    this.silenceAll();
    const finalPedals = { ...state.pedals };
    try {
      for (const restored of state.voices) {
        this.pedalState.soft = restored.softPedalAtPress;
        this.noteOn(restored.noteId, restored.pitch, restored.velocity, this.audioContext.currentTime);
        const voice = this.activeVoices.get(restored.noteId);
        if (!voice) continue;
        voice.keyState = restored.keyState;
        voice.heldBySostenuto = restored.heldBySostenuto;
        voice.sustainedBySustain = restored.sustainedBySustain;
      }
      this.pedalState.sustain = finalPedals.sustain;
      this.pedalState.sostenuto = finalPedals.sostenuto;
      this.pedalState.soft = finalPedals.soft;
    } catch (error) {
      this.silenceAll();
      throw error;
    }
  }

  /**
   * Disposes the sampler and cleans up all audio nodes.
   */
  public dispose(): void {
    this.silenceAll();
  }
}
