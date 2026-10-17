import type { RestoredPianoVoice } from "../sampler.ts";
import type { PedalState } from "../sampler.ts";
import {
  getSharedSoundFontSampleProvider,
  type SoundFontSampleLease,
} from "./soundfontSampleProvider.ts";
import type { Sf2Preset, Sf2SoundFont, Sf2Zone, SoundFontSynthOptions } from "./types.ts";

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
  sampleIndices: number[];
  sampleLeases: SoundFontSampleLease[];
  sourceNodes: AudioBufferSourceNode[];
  gainNodes: GainNode[];
  panNodes: StereoPannerNode[];
  tailSourceNodes: AudioBufferSourceNode[];
  tailChannelIndices: number[];
  endedSourceNodes: Set<AudioBufferSourceNode>;
  endedTailSourceNodes: Set<AudioBufferSourceNode>;
  gainNode: GainNode;
  panNode?: StereoPannerNode;
  startTime: number;
  playbackRate: number;
  loopStartSeconds: Array<number | undefined>;
  loopEndSeconds: Array<number | undefined>;
  loopWhileHeld: boolean[];
  attackSeconds: number[];
  holdSeconds: number[];
  decaySeconds: number[];
  peakGain: number[];
  sustainGain: number[];
  releaseSeconds: number[];
  keyState: "down" | "up";
  keyReleaseTime?: number;
  releaseStartTime?: number;
  heldBySostenuto: boolean;
  sostenutoCapturedAtBaseline: boolean;
  sustainedByPedal: boolean;
  sampleModes: number[];
}

interface PlaybackLayer {
  rightZone?: Sf2Zone;
  zoneIndex: number;
  channels: Array<{ sampleIndex: number; zone: Sf2Zone; side: "left" | "right" | "mono" }>;
  sampleIndices: number[];
  primarySampleIndex: number;
  rootKey: number;
  pitchCorrection: number;
  isStereo: boolean;
}

interface PendingPreparation {
  indices: Set<number>;
  generation: number;
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
  settled: boolean;
}

export interface SoundFontPedalState {
  sustain: boolean;
  sostenuto: boolean;
  soft: boolean;
}

/** Polyphonic SF2/SF3 sample playback with scheduled notes, pedals, and a bounded decoded cache. */
export class SoundFontSynth {
  private readonly audioContext: AudioContext | OfflineAudioContext;
  private readonly maxPolyphony: number;
  private soundFont: Sf2SoundFont | null = null;
  private activePreset: Sf2Preset | null = null;
  private readonly audioBufferCache = new Map<number, DecodedSample>();
  private readonly sampleProvider = getSharedSoundFontSampleProvider();
  private readonly activeVoices = new Map<string, ActiveVoice>();
  private pedalEvents: Array<{ controller: 64 | 66 | 67; value: number; time: number }> = [];
  private cachedBytes = 0;
  private cacheClock = 0;
  private pedalState: SoundFontPedalState = { sustain: false, sostenuto: false, soft: false };
  private pedalBaseline: SoundFontPedalState = { sustain: false, sostenuto: false, soft: false };
  private masterGain: GainNode;
  private preparedLeases = new Map<number, SoundFontSampleLease>();
  private preparedSampleIndices = new Set<number>();
  private preparationController: AbortController | null = null;
  private pendingPreparation: PendingPreparation | null = null;
  private preparationGeneration = 0;
  private disposed = false;

  constructor(options: SoundFontSynthOptions) {
    this.audioContext = options.audioContext;
    this.maxPolyphony = options.maxPolyphony ?? 64;
    this.masterGain = this.audioContext.createGain();
    // Output normalization is applied once by the shared master gain downstream.
    this.masterGain.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.masterGain.connect(options.destinationNode ?? this.audioContext.destination);
  }

  public loadSoundFont(sf: Sf2SoundFont, presetIndex?: number): void {
    this.cancelPreparation();
    this.releasePreparedSamples();
    this.silenceAll();
    this.audioBufferCache.clear();
    this.cachedBytes = 0;
    this.soundFont = sf;
    this.activePreset = presetIndex !== undefined
      ? (sf.presets[presetIndex] ?? sf.presets[0] ?? null)
      : (sf.presets.find((item) => item.bankNumber === 0 && item.presetNumber === 0)
        ?? sf.presets.find((item) => item.bankNumber === 0 && item.presetNumber <= 7)
        ?? sf.presets[0]
        ?? null);
  }

  public selectPreset(presetNumber: number, bankNumber = 0): boolean {
    if (!this.soundFont) return false;
    const preset = this.soundFont.presets.find((item) => item.presetNumber === presetNumber && item.bankNumber === bankNumber);
    if (!preset) return false;
    this.cancelPreparation();
    this.releasePreparedSamples();
    this.activePreset = preset;
    return true;
  }

  /**
   * Prepares and pins the samples selected by notes before synchronous playback.
   * A replacement lease set becomes visible only after every required sample is ready.
   */
  public async prepareNotes(
    notes: readonly { pitch: number; velocity: number }[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.disposed) throw new Error("SoundFont synth has been disposed.");
    if (signal?.aborted) throw abortError();
    if (!this.soundFont || !this.activePreset) throw new Error("No SoundFont preset is loaded.");

    const requestedIndices = this.resolvePreparedSampleIndices(notes);
    if (sameNumberSet(this.preparedSampleIndices, requestedIndices)) {
      if (this.pendingPreparation && !sameNumberSet(this.pendingPreparation.indices, requestedIndices)) this.cancelPreparation();
      return;
    }
    if (this.soundFont.sampleSource && this.pendingPreparation &&
        sameNumberSet(this.pendingPreparation.indices, requestedIndices)) {
      return this.waitForPreparation(this.pendingPreparation, signal);
    }
    this.cancelPreparation();
    const generation = ++this.preparationGeneration;
    const controller = new AbortController();
    this.preparationController = controller;

    if (!this.soundFont.sampleSource) {
      const staged = new Map<number, SoundFontSampleLease>();
      try {
        for (const index of requestedIndices) {
          const lease = this.acquireReadySample(index);
          if (!lease) throw new Error(`SoundFont sample ${index} could not be prepared.`);
          staged.set(index, lease);
        }
        this.assertCurrentPreparation(generation, controller.signal);
        const previous = this.preparedLeases;
        this.preparedLeases = staged;
        for (const lease of previous.values()) lease.release();
        this.preparedSampleIndices = requestedIndices;
      } catch (error) {
        for (const lease of staged.values()) lease.release();
        throw error;
      } finally {
        if (this.preparationController === controller) this.preparationController = null;
      }
      return;
    }

    const pending: PendingPreparation = {
      indices: requestedIndices,
      generation,
      controller,
      promise: Promise.resolve(),
      waiters: 0,
      settled: false,
    };
    this.pendingPreparation = pending;
    pending.promise = this.runFileBackedPreparation(pending);
    return this.waitForPreparation(pending, signal);
  }

  private async runFileBackedPreparation(pending: PendingPreparation): Promise<void> {
    let staged = new Map<number, SoundFontSampleLease>();
    try {
      staged = await this.sampleProvider.prepareSamples(
        this.soundFont!, [...pending.indices], this.audioContext, pending.controller.signal,
      );
      this.assertCurrentPreparation(pending.generation, pending.controller.signal);
      const previous = this.preparedLeases;
      this.preparedLeases = staged;
      staged = new Map();
      this.preparedSampleIndices = pending.indices;
      for (const lease of previous.values()) lease.release();
    } finally {
      for (const lease of staged.values()) lease.release();
      pending.settled = true;
      if (this.pendingPreparation === pending) this.pendingPreparation = null;
      if (this.preparationController === pending.controller) this.preparationController = null;
    }
  }

  private waitForPreparation(pending: PendingPreparation, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    pending.waiters++;
    return new Promise<void>((resolve, reject) => {
      let active = true;
      const finish = (error?: unknown) => {
        if (!active) return;
        active = false;
        signal?.removeEventListener("abort", onAbort);
        pending.waiters = Math.max(0, pending.waiters - 1);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = () => {
        finish(abortError());
        if (pending.waiters === 0 && !pending.settled && this.pendingPreparation === pending) {
          pending.controller.abort();
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.promise.then(() => finish(), (error: unknown) => finish(error));
    });
  }

  /** True only when the currently leased preparation covers all selected layers. */
  public areNotesPrepared(notes: readonly { pitch: number; velocity: number }[]): boolean {
    if (!this.soundFont || !this.activePreset) return false;
    let required: Set<number>;
    try {
      required = this.resolvePreparedSampleIndices(notes);
    } catch {
      return false;
    }
    for (const index of required) {
      if (this.soundFont.sampleSource) {
        if (!this.preparedSampleIndices.has(index) || !this.sampleProvider.getCachedBuffer(this.soundFont, index)) return false;
      } else if (!this.audioBufferCache.has(index)) {
        return false;
      }
    }
    return true;
  }

  private resolvePreparedSampleIndices(notes: readonly { pitch: number; velocity: number }[]): Set<number> {
    const required = new Set<number>();
    for (const note of notes) {
      const rawVelocity = Math.max(1, Math.min(127, Math.round(note.velocity)));
      for (const velocity of new Set([rawVelocity, Math.max(1, Math.round(rawVelocity * 0.7))])) {
        for (const layer of this.resolvePlaybackLayers(note.pitch, velocity)) {
          for (const sampleIndex of layer.sampleIndices) required.add(sampleIndex);
        }
      }
    }
    return required;
  }

  private resolvePlaybackLayers(pitch: number, velocity: number): PlaybackLayer[] {
    if (!this.soundFont || !this.activePreset) return [];
    let selected = this.activePreset.zones.map((zone, zoneIndex) => ({ zone, zoneIndex }))
      .filter(({ zone }) => pitch >= zone.keyRange[0] && pitch <= zone.keyRange[1] &&
        velocity >= zone.velRange[0] && velocity <= zone.velRange[1]);
    if (selected.length === 0) {
      const pitchZones = this.activePreset.zones.map((zone, zoneIndex) => ({ zone, zoneIndex }))
        .filter(({ zone }) => pitch >= zone.keyRange[0] && pitch <= zone.keyRange[1]);
      if (pitchZones.length > 0) {
        let minDistance = Number.POSITIVE_INFINITY;
        for (const pz of pitchZones) {
          const dist = velocity < pz.zone.velRange[0]
            ? pz.zone.velRange[0] - velocity
            : velocity > pz.zone.velRange[1]
              ? velocity - pz.zone.velRange[1]
              : 0;
          if (dist < minDistance) {
            minDistance = dist;
          }
        }
        selected = pitchZones.filter((pz) => {
          const dist = velocity < pz.zone.velRange[0]
            ? pz.zone.velRange[0] - velocity
            : velocity > pz.zone.velRange[1]
              ? velocity - pz.zone.velRange[1]
              : 0;
          return dist === minDistance;
        });
      }
    }
    const layers: PlaybackLayer[] = [];
    const stereoGroups = new Map<string, {
      leftIndex: number;
      rightIndex: number;
      rightSample: Sf2SoundFont["samples"][number];
      leftZones: Array<{ zone: Sf2Zone; zoneIndex: number }>;
      rightZones: Array<{ zone: Sf2Zone; zoneIndex: number }>;
    }>();
    for (const { zone, zoneIndex } of selected) {
      const sample = this.soundFont.samples[zone.sampleIndex];
      if (!sample) throw new Error(`SoundFont zone ${zoneIndex} refers to missing sample ${zone.sampleIndex}.`);
      const sampleType = sample.sampleType & 0x7fef;
      // MuseScore SF3 intentionally leaves SHDR links at zero. Its channel
      // zones carry their own pan/tuning and must each play once, without
      // guessing a partner by name or weakening reciprocal SF2 validation.
      const zeroTarget = this.soundFont.samples[0];
      const reciprocalZero = zeroTarget?.sampleLink === zone.sampleIndex &&
        (zeroTarget.sampleType & 0x7fef) === (sampleType === 4 ? 2 : 4);
      const unlinkedSf3 = sample.compressed && sample.sampleLink === 0 && !reciprocalZero && (sampleType === 2 || sampleType === 4);
      if (sampleType === 1 || unlinkedSf3) {
        layers.push({
          channels: [{ sampleIndex: zone.sampleIndex, zone, side: unlinkedSf3 ? (sampleType === 4 ? "left" : "right") : "mono" }],
          zoneIndex,
          sampleIndices: [zone.sampleIndex],
          primarySampleIndex: zone.sampleIndex,
          rootKey: zone.rootKey ?? sample.originalPitch ?? 60,
          pitchCorrection: zone.pitchCorrection ?? sample.pitchCorrection ?? 0,
          isStereo: false,
        });
        continue;
      }
      if (sampleType !== 2 && sampleType !== 4) {
        throw new Error(`SoundFont sample '${sample.name}' uses unsupported sampleType ${sample.sampleType}; supported playback types are mono, right, and left.`);
      }

      const { leftIndex, rightIndex, rightSample } = this.resolveStereoPair(zone.sampleIndex, sampleType);
      const groupKey = [
        zone.instrumentId ?? "unscoped-instrument",
        zone.presetZoneId ?? "unscoped-preset-zone",
        leftIndex,
        rightIndex,
        zone.keyRange.join(":"),
        zone.velRange.join(":"),
      ].join("|");
      let group = stereoGroups.get(groupKey);
      if (!group) {
        group = { leftIndex, rightIndex, rightSample, leftZones: [], rightZones: [] };
        stereoGroups.set(groupKey, group);
      }
      (sampleType === 4 ? group.leftZones : group.rightZones).push({ zone, zoneIndex });
    }

    for (const group of stereoGroups.values()) {
      group.leftZones.sort((a, b) => zoneOrder(a.zone, a.zoneIndex) - zoneOrder(b.zone, b.zoneIndex));
      group.rightZones.sort((a, b) => zoneOrder(a.zone, a.zoneIndex) - zoneOrder(b.zone, b.zoneIndex));
      if (group.leftZones.length !== group.rightZones.length) {
        throw new Error(
          `SoundFont stereo pair '${this.soundFont.samples[group.rightIndex]?.name ?? group.rightIndex}' has ${group.leftZones.length} left zones and ${group.rightZones.length} right zones for one instrument layer set.`,
        );
      }
      const layerCount = group.leftZones.length;
      for (let index = 0; index < layerCount; index++) {
        const left = group.leftZones[index]!;
        const right = group.rightZones[index]!;
        const leftZone = left.zone;
        const rightZone = right.zone;
        const layerZoneIndex = right.zoneIndex;
        layers.push({
          rightZone,
          zoneIndex: layerZoneIndex,
          channels: [
            { sampleIndex: group.leftIndex, zone: leftZone, side: "left" },
            { sampleIndex: group.rightIndex, zone: rightZone, side: "right" },
          ],
          sampleIndices: [group.leftIndex, group.rightIndex],
          primarySampleIndex: group.rightIndex,
          rootKey: right.zone.rootKey ?? group.rightSample.originalPitch ?? 60,
          pitchCorrection: right.zone.pitchCorrection ?? group.rightSample.pitchCorrection ?? 0,
          isStereo: true,
        });
      }
    }
    return layers.sort((a, b) => a.zoneIndex - b.zoneIndex);
  }

  private resolveStereoPair(sampleIndex: number, sampleType: number): {
    leftIndex: number;
    rightIndex: number;
    rightSample: NonNullable<Sf2SoundFont["samples"][number]>;
  } {
    if (!this.soundFont) throw new Error("No SoundFont is loaded.");
    const sample = this.soundFont.samples[sampleIndex];
    const linkedIndex = sample?.sampleLink;
    if (!sample || linkedIndex === undefined || !Number.isInteger(linkedIndex) || linkedIndex < 0 || linkedIndex >= this.soundFont.samples.length) {
      throw new Error(`SoundFont stereo sample '${sample?.name ?? sampleIndex}' has no valid linked channel.`);
    }
    const linked = this.soundFont.samples[linkedIndex];
    const expectedType = sampleType === 2 ? 4 : 2;
    if (!linked || (linked.sampleType & 0x7fef) !== expectedType || linked.sampleLink !== sampleIndex) {
      throw new Error(`SoundFont stereo sample '${sample.name}' has an orphaned or inconsistent channel link.`);
    }
    const rightIndex = sampleType === 2 ? sampleIndex : linkedIndex;
    const leftIndex = sampleType === 4 ? sampleIndex : linkedIndex;
    const rightSample = this.soundFont.samples[rightIndex];
    const leftSample = this.soundFont.samples[leftIndex];
    if (!rightSample || !leftSample || rightSample.sampleRate !== leftSample.sampleRate) {
      throw new Error(`SoundFont stereo pair '${sample.name}' and '${linked.name}' has mismatched sample rates.`);
    }
    return { leftIndex, rightIndex, rightSample };
  }

  private acquireReadySample(sampleIndex: number): SoundFontSampleLease | null {
    if (!this.soundFont) return null;
    if (this.soundFont.sampleSource) return this.sampleProvider.retainSample(this.soundFont, sampleIndex);
    const decoded = this.getOrCreateRawAudioBuffer(sampleIndex);
    if (!decoded) return null;
    decoded.pins++;
    decoded.lastUse = ++this.cacheClock;
    return {
      sampleIndex,
      buffer: decoded.buffer,
      release: () => {
        decoded.pins = Math.max(0, decoded.pins - 1);
        decoded.lastUse = ++this.cacheClock;
        this.evictInactiveSamples();
      },
    };
  }

  private assertCurrentPreparation(generation: number, signal: AbortSignal): void {
    if (this.disposed || signal.aborted || generation !== this.preparationGeneration) throw abortError();
  }

  private cancelPreparation(): void {
    this.preparationGeneration++;
    this.preparationController?.abort();
    this.preparationController = null;
    this.pendingPreparation = null;
  }

  private releasePreparedSamples(): void {
    for (const lease of this.preparedLeases.values()) lease.release();
    this.preparedLeases.clear();
    this.preparedSampleIndices.clear();
  }

  /**
   * Warms all velocity zones for the given notes into the shared LRU sample cache
   * without replacing the currently pinned window leases.
   */
  public warmNotesInCache(notes: readonly { pitch: number; velocity: number }[]): void {
    if (this.disposed || !this.soundFont?.sampleSource || !this.activePreset) return;
    const expanded: Array<{ pitch: number; velocity: number }> = [];
    const seenPitches = new Set<number>();
    for (const n of notes) {
      expanded.push(n);
      if (!seenPitches.has(n.pitch)) {
        seenPitches.add(n.pitch);
        for (const v of [32, 64, 92, 118]) {
          expanded.push({ pitch: n.pitch, velocity: v });
        }
      }
    }
    const indices = [...this.resolvePreparedSampleIndices(expanded)].filter(
      (idx) => !this.sampleProvider.getCachedBuffer(this.soundFont!, idx),
    );
    if (indices.length === 0) return;
    const sf = this.soundFont;
    void this.sampleProvider
      .prepareSamples(sf, indices, this.audioContext)
      .then((leases) => {
        for (const lease of leases.values()) lease.release();
      })
      .catch(() => {
        // Best-effort background cache warm-up
      });
  }

  private isLayerReady(layer: PlaybackLayer): boolean {
    if (!this.soundFont) return false;
    for (const sampleIndex of layer.sampleIndices) {
      if (this.soundFont.sampleSource) {
        if (!this.sampleProvider.getCachedBuffer(this.soundFont, sampleIndex)) return false;
      } else if (!this.getOrCreateRawAudioBuffer(sampleIndex)) {
        return false;
      }
    }
    return true;
  }

  private findNearestReadyLayers(pitch: number, effectiveVelocity: number): PlaybackLayer[] {
    if (!this.soundFont || !this.activePreset) return [];
    const candidateVelocities = [effectiveVelocity, 96, 80, 64, 48, 112, 32, 124, 16];
    for (let delta = 0; delta <= 36; delta++) {
      const pitches = delta === 0 ? [pitch] : [pitch - delta, pitch + delta];
      for (const candidatePitch of pitches) {
        if (candidatePitch < 0 || candidatePitch > 127) continue;
        const zoneVels = new Set<number>(candidateVelocities);
        for (const zone of this.activePreset.zones) {
          if (candidatePitch >= zone.keyRange[0] && candidatePitch <= zone.keyRange[1]) {
            zoneVels.add(Math.round((zone.velRange[0] + zone.velRange[1]) / 2));
          }
        }
        const sortedVels = [...zoneVels].sort(
          (a, b) => Math.abs(a - effectiveVelocity) - Math.abs(b - effectiveVelocity),
        );
        for (const v of sortedVels) {
          const layers = this.resolvePlaybackLayers(candidatePitch, v);
          if (layers.length > 0 && layers.every((layer) => this.isLayerReady(layer))) {
            return layers;
          }
        }
      }
    }
    return [];
  }

  /**
   * Plays a note using the closest already-decoded SoundFont velocity/pitch zone
   * when the exact (pitch, velocity) zone has not been decoded yet.
   */
  public tryNoteOnNearestReady(
    pitch: number,
    velocity: number,
    noteId = `p${pitch}-t${Date.now()}`,
    scheduledTime = this.audioContext.currentTime,
    softPedalAtPress = this.pedalState.soft,
  ): boolean {
    if (!this.soundFont || !this.activePreset) return false;
    const time = Math.max(this.audioContext.currentTime, scheduledTime);
    const effectiveVelocity = softPedalAtPress ? Math.max(1, Math.round(velocity * 0.7)) : velocity;
    if (effectiveVelocity <= 0) return false;
    const layers = this.findNearestReadyLayers(pitch, effectiveVelocity);
    if (!layers.length) return false;
    try {
      this.startLayers(layers, pitch, effectiveVelocity, noteId, time);
      return true;
    } catch {
      return false;
    }
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
    const effectiveVelocity = softPedalAtPress ? Math.max(1, Math.round(velocity * 0.7)) : velocity;
    if (effectiveVelocity <= 0) return;
    const layers = this.resolvePlaybackLayers(pitch, effectiveVelocity);
    if (!layers.length) {
      throw new Error(`SoundFont active preset '${this.activePreset.name}' has no sample layers for pitch ${pitch}.`);
    }
    this.startLayers(layers, pitch, effectiveVelocity, noteId, time);
  }

  private startLayers(
    layers: PlaybackLayer[],
    pitch: number,
    effectiveVelocity: number,
    noteId: string,
    time: number,
  ): void {
    if (!this.soundFont) return;
    if ("state" in this.audioContext && this.audioContext.state === "suspended" && typeof this.audioContext.resume === "function") {
      void this.audioContext.resume().catch(() => {});
    }

    const leases: SoundFontSampleLease[] = [];
    const buffers = new Map<number, AudioBuffer>();
    try {
      for (const layer of layers) {
        for (const sampleIndex of layer.sampleIndices) {
          const lease = this.acquireReadySample(sampleIndex);
          if (!lease) {
            throw new Error(`SoundFont note ${pitch} at velocity ${effectiveVelocity} was not prepared; refusing to decode during noteOn.`);
          }
          leases.push(lease);
          buffers.set(sampleIndex, lease.buffer);
        }
      }
    } catch (error) {
      for (const lease of leases) lease.release();
      throw error;
    }

    this.enforcePolyphonyLimit(layers.length);
    let leaseOffset = 0;
    const createdVoiceKeys: string[] = [];
    const partialSources: AudioBufferSourceNode[] = [];
    const partialGains: GainNode[] = [];
    const partialPans: StereoPannerNode[] = [];
    try {
      for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
        const layer = layers[layerIndex]!;
        const layerLeases = leases.slice(leaseOffset, leaseOffset + layer.sampleIndices.length);
        leaseOffset += layer.sampleIndices.length;
        const sourceNodes: AudioBufferSourceNode[] = [];
        const gainNodes: GainNode[] = [];
        const panNodes: StereoPannerNode[] = [];
        const sampleModes: number[] = [];
        const loopStartSeconds: Array<number | undefined> = [];
        const loopEndSeconds: Array<number | undefined> = [];
        const loopWhileHeld: boolean[] = [];
        for (const channel of layer.channels) {
          const channelSample = this.soundFont.samples[channel.sampleIndex]!;
          const channelMode = channel.zone.sampleModes ?? 0;
          let channelLoopStart: number | undefined;
          let channelLoopEnd: number | undefined;
          if (channelMode === 1 || channelMode === 3) {
            const rate = channelSample.sampleRate || 44_100;
            if (channelSample.loopStart >= channelSample.start && channelSample.loopEnd > channelSample.loopStart && channelSample.loopEnd <= channelSample.end) {
              const start = (channelSample.loopStart - channelSample.start) / rate;
              const end = (channelSample.loopEnd - channelSample.start) / rate;
              const channelBuffer = buffers.get(channel.sampleIndex)!;
              if (end > start && end <= channelBuffer.duration) {
                channelLoopStart = start;
                channelLoopEnd = end;
              }
            }
          }
          sampleModes.push(channelMode);
          loopStartSeconds.push(channelLoopStart);
          loopEndSeconds.push(channelLoopEnd);
          loopWhileHeld.push(channelLoopStart !== undefined && channelLoopEnd !== undefined &&
            (channelMode === 1 || channelMode === 3));
        }
        const cents = (pitch - layer.rootKey) * 100 + layer.pitchCorrection;
        const playbackRate = Math.pow(2, cents / 1200);
        const velScale = Math.max(0.20, (effectiveVelocity / 127) ** 1.5);
        const channelAttacks: number[] = [];
        const channelHolds: number[] = [];
        const channelDecays: number[] = [];
        const channelPeaks: number[] = [];
        const channelSustains: number[] = [];
        const channelReleases: number[] = [];

        for (let channelIndex = 0; channelIndex < layer.sampleIndices.length; channelIndex++) {
          const channel = layer.channels[channelIndex]!;
          const sampleIndex = channel.sampleIndex;
          const channelZone = channel.zone;
          const source = this.audioContext.createBufferSource();
          partialSources.push(source);
          source.buffer = buffers.get(sampleIndex)!;
          source.playbackRate.setValueAtTime(playbackRate, time);
          if (loopStartSeconds[channelIndex] !== undefined && loopEndSeconds[channelIndex] !== undefined) {
            source.loop = loopWhileHeld[channelIndex]!;
            source.loopStart = loopStartSeconds[channelIndex]!;
            source.loopEnd = loopEndSeconds[channelIndex]!;
          }

          const gainNode = this.audioContext.createGain();
          partialGains.push(gainNode);
          // initialAttenuationDb is attenuation in decibels, so convert it to
          // amplitude using 20 dB per decade.
          const attenuation = Math.pow(10, -(channelZone.initialAttenuationDb ?? 0) / 20);
          const peakGain = Math.max(0.0001, velScale * 0.5 * attenuation);
          const attack = Math.max(0.003, channelZone.attackSeconds ?? 0.005);
          const hold = Math.max(0, channelZone.holdSeconds ?? 0);
          const decay = Math.max(0, channelZone.decaySeconds ?? 0);
          const sustainPercent = Math.max(0, Math.min(100, channelZone.sustainPercent ?? 100));
          const sustainGain = Math.max(0.0001, peakGain * sustainPercent / 100);
          const release = Math.max(0.05, channelZone.releaseSeconds ?? 0.25);
          gainNode.gain.setValueAtTime(0.0001, time);
          gainNode.gain.exponentialRampToValueAtTime(peakGain, time + attack);
          this.scheduleHoldDecay(gainNode.gain, time + attack, hold, decay, peakGain, sustainGain);
          channelAttacks.push(attack);
          channelHolds.push(hold);
          channelDecays.push(decay);
          channelPeaks.push(peakGain);
          channelSustains.push(sustainGain);
          channelReleases.push(release);
          let outputNode: AudioNode = gainNode;
          let panNode: StereoPannerNode | undefined;
          const explicitPan = channelZone.sampleIndex === sampleIndex ? channelZone.pan : undefined;
          const panValue = explicitPan !== undefined
            ? explicitPan / 500
            : channel.side !== "mono"
              ? channel.side === "left" ? -1 : 1
              : undefined;
          if (panValue !== undefined && typeof this.audioContext.createStereoPanner === "function") {
            panNode = this.audioContext.createStereoPanner();
            partialPans.push(panNode);
            panNode.pan.setValueAtTime(Math.max(-1, Math.min(1, panValue)), time);
            gainNode.connect(panNode);
            outputNode = panNode;
            panNodes.push(panNode);
          }
          source.connect(gainNode);
          outputNode.connect(this.masterGain);
          source.start(time);
          sourceNodes.push(source);
          gainNodes.push(gainNode);
        }

        const voiceKey = `${noteId}-z${layer.zoneIndex}-${layer.primarySampleIndex}-${this.cacheClock++}`;
        const voice: ActiveVoice = {
          voiceKey,
          noteId: voiceKey,
          originalNoteId: noteId,
          pitch,
          velocity: effectiveVelocity,
          sampleIndex: layer.primarySampleIndex,
          sampleIndices: layer.sampleIndices,
          sampleLeases: layerLeases,
          sourceNodes,
          gainNodes,
          panNodes,
          tailSourceNodes: [],
          tailChannelIndices: [],
          endedSourceNodes: new Set(),
          endedTailSourceNodes: new Set(),
          gainNode: gainNodes[0]!,
          panNode: panNodes[0],
          startTime: time,
          playbackRate,
          loopStartSeconds,
          loopEndSeconds,
          loopWhileHeld,
          attackSeconds: channelAttacks,
          holdSeconds: channelHolds,
          decaySeconds: channelDecays,
          peakGain: channelPeaks,
          sustainGain: channelSustains,
          releaseSeconds: channelReleases,
          keyState: "down",
          heldBySostenuto: false,
          sostenutoCapturedAtBaseline: false,
          sustainedByPedal: false,
          sampleModes,
        };
        this.activeVoices.set(voiceKey, voice);
        createdVoiceKeys.push(voiceKey);
        for (const source of sourceNodes) {
          source.onended = () => {
            voice.endedSourceNodes.add(source);
            this.teardownVoiceIfEnded(voice);
          };
        }
      }
    } catch (error) {
      for (const key of createdVoiceKeys) this.teardownVoice(key, this.audioContext.currentTime);
      for (const source of partialSources) {
        try { source.stop(this.audioContext.currentTime); source.disconnect(); } catch { /* Ignore an already-stopped node. */ }
      }
      for (const gain of partialGains) {
        try { gain.disconnect(); } catch { /* Ignore a disconnected node. */ }
      }
      for (const pan of partialPans) {
        try { pan.disconnect(); } catch { /* Ignore a disconnected node. */ }
      }
      for (const lease of leases) lease.release();
      throw error;
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
  public getDecodedSampleCacheBytes(): number {
    return this.soundFont?.sampleSource ? this.sampleProvider.getStats().decodedBytes : this.cachedBytes;
  }
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
    this.disposed = true;
    this.cancelPreparation();
    this.releasePreparedSamples();
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

  private scheduleHoldDecay(
    gain: AudioParam,
    attackEnd: number,
    holdSeconds: number,
    decaySeconds: number,
    peakGain: number,
    sustainGain: number,
  ): void {
    const decayStart = attackEnd + holdSeconds;
    if (holdSeconds > 0 && (decaySeconds > 0 || sustainGain >= peakGain)) {
      gain.setValueAtTime(peakGain, decayStart);
    }
    if (sustainGain >= peakGain) return;
    if (decaySeconds > 0) gain.exponentialRampToValueAtTime(sustainGain, decayStart + decaySeconds);
    else gain.setValueAtTime(sustainGain, decayStart);
  }

  private scheduleEnvelopeAfter(voice: ActiveVoice, time: number, channelIndex: number): void {
    const gain = voice.gainNodes[channelIndex]!.gain;
    const attackEnd = voice.startTime + voice.attackSeconds[channelIndex]!;
    const holdSeconds = voice.holdSeconds[channelIndex] ?? 0;
    const decaySeconds = voice.decaySeconds[channelIndex] ?? 0;
    const holdEnd = attackEnd + holdSeconds;
    const decayEnd = holdEnd + decaySeconds;
    const peakGain = voice.peakGain[channelIndex]!;
    const sustainGain = voice.sustainGain[channelIndex]!;

    if (time < attackEnd) {
      gain.exponentialRampToValueAtTime(peakGain, attackEnd);
      this.scheduleHoldDecay(gain, attackEnd, holdSeconds, decaySeconds, peakGain, sustainGain);
    } else if (time < holdEnd) {
      this.scheduleHoldDecay(gain, attackEnd, holdSeconds, decaySeconds, peakGain, sustainGain);
    } else if (time < decayEnd && sustainGain < peakGain) {
      gain.exponentialRampToValueAtTime(sustainGain, decayEnd);
    }
  }

  private startVoiceRelease(voice: ActiveVoice, time: number): void {
    if (voice.releaseStartTime !== undefined && voice.releaseStartTime <= time) return;
    voice.releaseStartTime = time;
    const tailedChannels = this.scheduleMode3Tails(voice, time);
    for (let index = 0; index < voice.gainNodes.length; index++) {
      const gain = voice.gainNodes[index]!.gain;
      const atStart = Math.max(0.0001, this.envelopeGainAt(voice, time, index));
      try {
        gain.cancelScheduledValues(time);
        gain.setValueAtTime(atStart, time);
        gain.exponentialRampToValueAtTime(0.0001, time + voice.releaseSeconds[index]!);
      } catch { /* Keep the other channel envelopes scheduled if a node has ended. */ }
    }
    for (let index = 0; index < voice.sourceNodes.length; index++) {
      if (tailedChannels.has(index)) continue;
      try { voice.sourceNodes[index]!.stop(time + voice.releaseSeconds[index]! + 0.05); }
      catch { /* Ignore an already-ended source. */ }
    }
    for (let index = 0; index < voice.tailSourceNodes.length; index++) {
      const channelIndex = voice.tailChannelIndices[index]!;
      try { voice.tailSourceNodes[index]!.stop(time + voice.releaseSeconds[channelIndex]! + 0.05); }
      catch { /* Ignore an already-ended tail. */ }
    }
  }

  private cancelVoiceRelease(voice: ActiveVoice, time: number): void {
    voice.releaseStartTime = undefined;
    for (const tail of voice.tailSourceNodes) {
      tail.onended = null;
      try { tail.stop(time); } catch { /* Ignore an already-ended tail. */ }
      try { tail.disconnect(); } catch { /* Ignore a disconnected tail. */ }
    }
    voice.tailSourceNodes = [];
    voice.tailChannelIndices = [];
    voice.endedTailSourceNodes.clear();
    for (let index = 0; index < voice.gainNodes.length; index++) {
      const gain = voice.gainNodes[index]!.gain;
      const value = Math.max(0.0001, this.envelopeGainAt(voice, time, index));
      try {
        gain.cancelScheduledValues(time);
        gain.setValueAtTime(value, time);
        this.scheduleEnvelopeAfter(voice, time, index);
      } catch { /* Keep the other channel envelopes active. */ }
    }
    for (let index = 0; index < voice.sourceNodes.length; index++) {
      const source = voice.sourceNodes[index]!;
      try {
        // A later stop replaces an earlier scheduled stop; push it beyond the session.
        source.stop(time + 24 * 60 * 60);
      } catch { /* Ignore an already-ended source. */ }
      if (voice.loopWhileHeld[index]) source.loop = true;
    }
    this.teardownVoiceIfEnded(voice);
  }

  private envelopeGainAt(voice: ActiveVoice, time: number, channelIndex = 0): number {
    const attackSeconds = voice.attackSeconds[channelIndex] ?? voice.attackSeconds[0] ?? 0.005;
    const holdSeconds = voice.holdSeconds[channelIndex] ?? voice.holdSeconds[0] ?? 0;
    const decaySeconds = voice.decaySeconds[channelIndex] ?? voice.decaySeconds[0] ?? 0;
    const peakGain = voice.peakGain[channelIndex] ?? voice.peakGain[0] ?? 0.5;
    const sustainGain = voice.sustainGain[channelIndex] ?? voice.sustainGain[0] ?? peakGain;
    const releaseSeconds = voice.releaseSeconds[channelIndex] ?? voice.releaseSeconds[0] ?? 0.25;
    const attackEnd = voice.startTime + attackSeconds;
    const holdEnd = attackEnd + holdSeconds;
    const decayEnd = holdEnd + decaySeconds;
    const adsrGainAt = (at: number): number => {
      if (at <= voice.startTime) return 0.0001;
      if (at < attackEnd) {
        const ratio = (at - voice.startTime) / attackSeconds;
        return 0.0001 * Math.pow(peakGain / 0.0001, Math.max(0, ratio));
      }
      if (at < holdEnd) return peakGain;
      if (at < decayEnd && decaySeconds > 0) {
        const ratio = (at - holdEnd) / decaySeconds;
        return peakGain * Math.pow(sustainGain / peakGain, Math.max(0, ratio));
      }
      return sustainGain;
    };
    if (voice.releaseStartTime !== undefined && time >= voice.releaseStartTime) {
      const releaseRatio = Math.min(1, (time - voice.releaseStartTime) / releaseSeconds);
      const start = Math.max(0.0001, adsrGainAt(voice.releaseStartTime));
      return start * Math.pow(0.0001 / start, releaseRatio);
    }
    return adsrGainAt(time);
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
    if (voice.releaseStartTime !== undefined) return;
    for (let index = 0; index < voice.sourceNodes.length; index++) {
      if (voice.loopWhileHeld[index]) voice.sourceNodes[index]!.loop = true;
    }
  }

  private scheduleMode3Tails(voice: ActiveVoice, time: number): Set<number> {
    const tailedChannels = new Set<number>();
    for (let index = 0; index < voice.sourceNodes.length; index++) {
      const source = voice.sourceNodes[index]!;
      const loopStartSeconds = voice.loopStartSeconds[index];
      const loopEndSeconds = voice.loopEndSeconds[index];
      if (voice.sampleModes[index] !== 3 || !source.loop || loopStartSeconds === undefined ||
          loopEndSeconds === undefined || !source.buffer) continue;
      const loopDuration = loopEndSeconds - loopStartSeconds;
      if (loopDuration <= 0) continue;
      const firstLoopTime = voice.startTime + loopEndSeconds / voice.playbackRate;
      const elapsed = Math.max(0, time - voice.startTime);
      const offset = time < firstLoopTime
        ? elapsed * voice.playbackRate
        : loopStartSeconds + (((time - firstLoopTime) * voice.playbackRate) % loopDuration);
      const tail = this.audioContext.createBufferSource();
      tail.buffer = source.buffer;
      tail.playbackRate.setValueAtTime(voice.playbackRate, time);
      tail.connect(voice.gainNodes[index]!);
      const tailSampleRate = tail.buffer.sampleRate || 44_100;
      tail.start(time, Math.min(offset, Math.max(0, tail.buffer.duration - 1 / tailSampleRate)));
      voice.tailSourceNodes.push(tail);
      voice.tailChannelIndices.push(index);
      tailedChannels.add(index);
      tail.onended = () => {
        voice.endedTailSourceNodes.add(tail);
        this.teardownVoiceIfEnded(voice);
      }
    }
    for (const index of tailedChannels) {
      try { voice.sourceNodes[index]!.stop(time); }
      catch { /* Ignore an already-ended loop. */ }
    }
    return tailedChannels;
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
    for (const source of voice.sourceNodes) {
      source.onended = null;
      try { source.stop(time); } catch { /* Ignore already-ended nodes. */ }
      try { source.disconnect(); } catch { /* Ignore disconnected nodes. */ }
    }
    for (const tail of voice.tailSourceNodes) {
      tail.onended = null;
      try { tail.stop(time); } catch { /* Ignore already-ended nodes. */ }
      try { tail.disconnect(); } catch { /* Ignore disconnected nodes. */ }
    }
    for (const gain of voice.gainNodes) {
      try { gain.gain.cancelScheduledValues(time); gain.gain.setValueAtTime(0.0001, time); } catch { /* Ignore ended gains. */ }
      try { gain.disconnect(); } catch { /* Ignore disconnected nodes. */ }
    }
    for (const pan of voice.panNodes) {
      try { pan.disconnect(); } catch { /* Ignore disconnected nodes. */ }
    }
    this.activeVoices.delete(key);
    for (const lease of voice.sampleLeases) lease.release();
  }

  private teardownVoiceIfEnded(voice: ActiveVoice): void {
    if (this.activeVoices.get(voice.voiceKey) !== voice) return;
    const everyChannelEnded = voice.sourceNodes.every((source, channelIndex) => {
      const tailIndex = voice.tailChannelIndices.indexOf(channelIndex);
      if (tailIndex >= 0) {
        const tail = voice.tailSourceNodes[tailIndex];
        return tail !== undefined && voice.endedTailSourceNodes.has(tail);
      }
      return voice.endedSourceNodes.has(source);
    });
    if (everyChannelEnded) this.teardownVoice(voice.voiceKey, this.audioContext.currentTime);
  }

  private getOrCreateRawAudioBuffer(sampleIndex: number): DecodedSample | null {
    const cached = this.audioBufferCache.get(sampleIndex);
    if (cached) {
      cached.lastUse = ++this.cacheClock;
      return cached;
    }
    if (!this.soundFont?.rawSampleData) return null;
    const sample = this.soundFont.samples[sampleIndex];
    if (!sample) return null;
    const length = Math.min(sample.end - sample.start, this.soundFont.rawSampleData.length - sample.start);
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

function zoneOrder(zone: Sf2Zone, fallbackIndex: number): number {
  return zone.instrumentZoneId ?? fallbackIndex;
}

function sameNumberSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function abortError(): DOMException {
  return new DOMException("SoundFont preparation was cancelled.", "AbortError");
}
