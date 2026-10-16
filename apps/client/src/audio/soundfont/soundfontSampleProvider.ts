import type { Sf2SampleHeader, Sf2SoundFont } from "./types.ts";

export const SOUNDFONT_SAMPLE_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
export const SOUNDFONT_SAMPLE_INACTIVE_BUDGET_BYTES = 64 * 1024 * 1024;

export interface SoundFontSampleLease {
  readonly sampleIndex: number;
  readonly buffer: AudioBuffer;
  release(): void;
}

export interface SoundFontSampleProviderStats {
  budgetBytes: number;
  inactiveBudgetBytes: number;
  decodedBytes: number;
  preparingBytes: number;
  inactiveBytes: number;
  pinnedBytes: number;
  cachedSamples: number;
  preparingSamples: number;
  reads: number;
  decodes: number;
  cacheHits: number;
}

interface SampleDescriptor {
  readonly blob: Blob;
  readonly sampleDataOffset: number;
  readonly sampleCount: number;
  readonly sampleDataByteLength: number;
  readonly sampleIndex: number;
  readonly sample: Sf2SampleHeader;
  readonly compressed: boolean;
  readonly compressedByteStart?: number;
  readonly compressedByteEnd?: number;
  readonly decodedFrameCount?: number;
  readonly cacheKey: string;
}

interface CachedSample {
  buffer: AudioBuffer;
  bytes: number;
  pins: number;
  lastUse: number;
}

interface PendingSample {
  readonly controller: AbortController;
  promise: Promise<CachedSample>;
  readonly reservedBytes: number;
  pins: number;
  entry?: CachedSample;
  settled: boolean;
}

/** Shared per-tab range reader and bounded decoded AudioBuffer cache. */
export class SoundFontSampleProvider {
  private readonly cache = new Map<string, CachedSample>();
  private readonly pending = new Map<string, PendingSample>();
  private readonly blobIds = new WeakMap<Blob, number>();
  private nextBlobId = 1;
  private clock = 0;
  private reservedBytes = 0;
  private readCount = 0;
  private decodeCount = 0;
  private cacheHitCount = 0;

  constructor(
    private readonly budgetBytes = SOUNDFONT_SAMPLE_CACHE_BUDGET_BYTES,
    private readonly inactiveBudgetBytes = SOUNDFONT_SAMPLE_INACTIVE_BUDGET_BYTES,
  ) {}

  public async prepareSamples(
    soundFont: Sf2SoundFont,
    sampleIndices: readonly number[],
    audioContext: AudioContext | OfflineAudioContext,
    signal?: AbortSignal,
  ): Promise<Map<number, SoundFontSampleLease>> {
    if (signal?.aborted) throw abortError();
    const descriptors = new Map<number, SampleDescriptor>();
    for (const sampleIndex of new Set(sampleIndices)) {
      const descriptor = this.describe(soundFont, sampleIndex);
      if (descriptor) descriptors.set(sampleIndex, descriptor);
    }
    this.preflight([...descriptors.values()]);

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const leases = new Map<number, SoundFontSampleLease>();
    try {
      const entries = await Promise.allSettled([...descriptors.values()].map(async (descriptor) => {
        const lease = await this.acquire(descriptor, audioContext, controller.signal);
        leases.set(descriptor.sampleIndex, lease);
        return lease;
      }));
      const failure = entries.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) {
        controller.abort();
        for (const result of entries) {
          if (result.status === "fulfilled") result.value.release();
        }
        for (const lease of leases.values()) lease.release();
        if (signal?.aborted) throw abortError();
        throw failure.reason;
      }
      if (signal?.aborted) {
        for (const lease of leases.values()) lease.release();
        throw abortError();
      }
      return leases;
    } catch (error) {
      controller.abort();
      for (const lease of leases.values()) lease.release();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /** Retains an already decoded sample without initiating I/O or decoding. */
  public retainSample(soundFont: Sf2SoundFont, sampleIndex: number): SoundFontSampleLease | null {
    const descriptor = this.describe(soundFont, sampleIndex);
    if (!descriptor) return null;
    const entry = this.cache.get(descriptor.cacheKey);
    if (!entry) return null;
    entry.pins++;
    entry.lastUse = ++this.clock;
    return this.makeLease(sampleIndex, descriptor.cacheKey, entry);
  }

  /** Returns a cached buffer without starting any asynchronous work. */
  public getCachedBuffer(soundFont: Sf2SoundFont, sampleIndex: number): AudioBuffer | null {
    const descriptor = this.describe(soundFont, sampleIndex);
    if (!descriptor) return null;
    const entry = this.cache.get(descriptor.cacheKey);
    if (!entry) return null;
    entry.lastUse = ++this.clock;
    return entry.buffer;
  }

  public getStats(): SoundFontSampleProviderStats {
    let decodedBytes = 0;
    let inactiveBytes = 0;
    let pinnedBytes = 0;
    for (const sample of this.cache.values()) {
      decodedBytes += sample.bytes;
      if (sample.pins === 0) inactiveBytes += sample.bytes;
      else pinnedBytes += sample.bytes;
    }
    return {
      budgetBytes: this.budgetBytes,
      inactiveBudgetBytes: this.inactiveBudgetBytes,
      decodedBytes,
      preparingBytes: this.reservedBytes,
      inactiveBytes,
      pinnedBytes,
      cachedSamples: this.cache.size,
      preparingSamples: this.pending.size,
      reads: this.readCount,
      decodes: this.decodeCount,
      cacheHits: this.cacheHitCount,
    };
  }

  /** Cancels pending range reads and releases all cached entries. Test-only lifecycle hook. */
  public reset(): void {
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
    this.cache.clear();
    this.reservedBytes = 0;
  }

  private describe(soundFont: Sf2SoundFont, sampleIndex: number): SampleDescriptor | null {
    const source = soundFont.sampleSource;
    const sample = soundFont.samples[sampleIndex];
    if (!source || !sample) return null;
    let blobId = this.blobIds.get(source.blob);
    if (blobId === undefined) {
      blobId = this.nextBlobId++;
      this.blobIds.set(source.blob, blobId);
    }
    return {
      blob: source.blob,
      sampleDataOffset: source.sampleDataOffset,
      sampleCount: source.sampleCount,
      sampleDataByteLength: source.sampleDataByteLength ?? source.sampleCount * 2,
      sampleIndex,
      sample,
      compressed: sample.compressed === true,
      compressedByteStart: sample.compressedByteStart,
      compressedByteEnd: sample.compressedByteEnd,
      decodedFrameCount: sample.decodedFrameCount,
      cacheKey: `${source.assetId ? `asset:${source.assetId}` : `blob:${blobId}`}:${source.sampleDataOffset}:${sampleIndex}:${sample.start}:${sample.end}:${sample.sampleRate}:${sample.compressed ? `${sample.compressedByteStart}-${sample.compressedByteEnd}-${sample.decodedFrameCount}` : "pcm"}`,
    };
  }

  private preflight(descriptors: readonly SampleDescriptor[]): void {
    let additionalBytes = 0;
    for (const descriptor of descriptors) {
      if (this.cache.has(descriptor.cacheKey) || this.pending.has(descriptor.cacheKey)) continue;
      additionalBytes += this.reservationBytes(descriptor);
    }

    let pinnedBytes = 0;
    const protectedKeys = new Set<string>();
    for (const descriptor of descriptors) {
      const cached = this.cache.get(descriptor.cacheKey);
      if (cached && cached.pins === 0) protectedKeys.add(descriptor.cacheKey);
    }
    for (const entry of this.cache.values()) if (entry.pins > 0) pinnedBytes += entry.bytes;
    const inactiveAllowance = this.budgetBytes - this.reservedBytes - additionalBytes - pinnedBytes;
    this.evictInactiveUntil(inactiveAllowance, protectedKeys);
    const decodedBytes = [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const totalRequired = decodedBytes + this.reservedBytes + additionalBytes;
    if (totalRequired > this.budgetBytes) {
      throw new Error(
        `SoundFont sample preparation needs ${formatBytes(totalRequired)} but the shared cache budget is ${formatBytes(this.budgetBytes)}.`,
      );
    }
  }

  private async acquire(
    descriptor: SampleDescriptor,
    audioContext: AudioContext | OfflineAudioContext,
    signal: AbortSignal,
  ): Promise<SoundFontSampleLease> {
    if (signal.aborted) throw abortError();
    const cached = this.cache.get(descriptor.cacheKey);
    if (cached) {
      cached.pins++;
      cached.lastUse = ++this.clock;
      this.cacheHitCount++;
      return this.makeLease(descriptor.sampleIndex, descriptor.cacheKey, cached);
    }

    let pending = this.pending.get(descriptor.cacheKey);
    if (!pending) pending = this.startLoad(descriptor, audioContext);
    pending.pins++;

    return new Promise<SoundFontSampleLease>((resolve, reject) => {
      let active = true;
      const releasePendingPin = () => {
        if (!active) return;
        active = false;
        signal.removeEventListener("abort", onAbort);
        if (pending!.entry) {
          pending!.entry.pins = Math.max(0, pending!.entry.pins - 1);
          pending!.entry.lastUse = ++this.clock;
          this.pruneInactive();
        } else {
          pending!.pins = Math.max(0, pending!.pins - 1);
          if (pending!.pins === 0 && !pending!.settled) pending!.controller.abort();
        }
      };
      const onAbort = () => {
        if (!active) return;
        releasePendingPin();
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending!.promise.then((entry) => {
        if (!active || signal.aborted) {
          releasePendingPin();
          if (active) reject(abortError());
          return;
        }
        active = false;
        signal.removeEventListener("abort", onAbort);
        entry.lastUse = ++this.clock;
        resolve(this.makeLease(descriptor.sampleIndex, descriptor.cacheKey, entry));
      }, (error: unknown) => {
        if (!active) return;
        releasePendingPin();
        reject(signal.aborted ? abortError() : error);
      });
    });
  }

  private startLoad(descriptor: SampleDescriptor, audioContext: AudioContext | OfflineAudioContext): PendingSample {
    const controller = new AbortController();
    const reservedBytes = this.reservationBytes(descriptor);
    this.reservedBytes += reservedBytes;
    const pending: PendingSample = {
      controller,
      reservedBytes,
      pins: 0,
      settled: false,
      promise: Promise.resolve(null as unknown as CachedSample),
    };
    pending.promise = this.load(descriptor, audioContext, controller.signal).then((entry) => {
      if (controller.signal.aborted) throw abortError();
      pending.entry = entry;
      entry.pins = pending.pins;
      entry.lastUse = ++this.clock;
      this.cache.set(descriptor.cacheKey, entry);
      this.reservedBytes = Math.max(0, this.reservedBytes - reservedBytes);
      pending.settled = true;
      this.pending.delete(descriptor.cacheKey);
      this.pruneInactive();
      return entry;
    }).catch((error: unknown) => {
      if (!pending.settled) {
        this.reservedBytes = Math.max(0, this.reservedBytes - reservedBytes);
        pending.settled = true;
        this.pending.delete(descriptor.cacheKey);
      }
      throw error;
    });
    this.pending.set(descriptor.cacheKey, pending);
    return pending;
  }

  private async load(
    descriptor: SampleDescriptor,
    audioContext: AudioContext | OfflineAudioContext,
    signal: AbortSignal,
  ): Promise<CachedSample> {
    const frames = this.sampleFrameCount(descriptor);
    if (descriptor.compressed) {
      const encodedStart = descriptor.compressedByteStart;
      const encodedEnd = descriptor.compressedByteEnd;
      if (!Number.isSafeInteger(encodedStart) || !Number.isSafeInteger(encodedEnd) || encodedStart! < 0 || encodedEnd! <= encodedStart! || encodedEnd! > descriptor.sampleDataByteLength) {
        throw new Error(`SoundFont sample ${descriptor.sampleIndex} has invalid compressed byte bounds.`);
      }
      const start = descriptor.sampleDataOffset + encodedStart!;
      const end = descriptor.sampleDataOffset + encodedEnd!;
      if (start < 0 || end <= start || end > descriptor.blob.size) {
        throw new Error(`SoundFont sample ${descriptor.sampleIndex} has compressed bytes outside the source Blob.`);
      }
      this.readCount++;
      const encodedBytes = await readBlobRange(descriptor.blob, start, end, signal);
      if (signal.aborted) throw abortError();
      const buffer = await decodeCompressedSample(encodedBytes, descriptor.sample.sampleRate, audioContext);
      if (signal.aborted) throw abortError();
      if (buffer.numberOfChannels !== 1 || buffer.sampleRate !== descriptor.sample.sampleRate || buffer.length !== frames) {
        throw new Error(`SoundFont sample ${descriptor.sampleIndex} decoded as ${buffer.numberOfChannels} channel(s), ${buffer.length} frames at ${buffer.sampleRate} Hz; expected 1 channel, ${frames} frames at ${descriptor.sample.sampleRate} Hz.`);
      }
      this.decodeCount++;
      return { buffer, bytes: frames * Float32Array.BYTES_PER_ELEMENT, pins: 0, lastUse: ++this.clock };
    }
    const start = descriptor.sampleDataOffset + descriptor.sample.start * 2;
    const end = descriptor.sampleDataOffset + descriptor.sample.end * 2;
    if (start < 0 || end < start || end > descriptor.blob.size) {
      throw new Error(`SoundFont sample ${descriptor.sampleIndex} has invalid file-backed PCM bounds.`);
    }
    this.readCount++;
    const pcmBytes = await readBlobRange(descriptor.blob, start, end, signal);
    const sampleRate = descriptor.sample.sampleRate || audioContext.sampleRate || 44_100;
    const buffer = audioContext.createBuffer(1, frames, sampleRate);
    const channel = buffer.getChannelData(0);
    const pcm = new DataView(pcmBytes);
    for (let index = 0; index < frames; index++) channel[index] = pcm.getInt16(index * 2, true) / 32768;
    if (signal.aborted) throw abortError();
    this.decodeCount++;
    return { buffer, bytes: frames * Float32Array.BYTES_PER_ELEMENT, pins: 0, lastUse: ++this.clock };
  }

  private sampleFrameCount(descriptor: SampleDescriptor): number {
    const { start, end } = descriptor.sample;
    const frames = descriptor.compressed ? descriptor.decodedFrameCount ?? end - start : end - start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || frames <= 0 || (!descriptor.compressed && end > descriptor.sampleCount)) {
      throw new Error(`SoundFont sample ${descriptor.sampleIndex} has invalid PCM sample bounds.`);
    }
    return frames;
  }

  private reservationBytes(descriptor: SampleDescriptor): number {
    const frames = this.sampleFrameCount(descriptor);
    const inputBytes = descriptor.compressed
      ? (descriptor.compressedByteEnd ?? 0) - (descriptor.compressedByteStart ?? 0)
      : frames * Int16Array.BYTES_PER_ELEMENT;
    // Compressed bytes and the decoded Float32 AudioBuffer coexist while
    // decodeAudioData runs. Keep the existing Int16 + Float32 PCM allowance.
    return inputBytes + frames * Float32Array.BYTES_PER_ELEMENT;
  }

  private makeLease(sampleIndex: number, cacheKey: string, entry: CachedSample): SoundFontSampleLease {
    let released = false;
    return {
      sampleIndex,
      buffer: entry.buffer,
      release: () => {
        if (released) return;
        released = true;
        entry.pins = Math.max(0, entry.pins - 1);
        entry.lastUse = ++this.clock;
        if (this.cache.get(cacheKey) === entry) this.pruneInactive();
      },
    };
  }

  private pruneInactive(): void {
    this.evictInactiveUntil(this.inactiveBudgetBytes);
  }

  private evictInactiveUntil(targetBytes: number, protectedKeys: ReadonlySet<string> = new Set()): void {
    let inactiveBytes = 0;
    for (const entry of this.cache.values()) if (entry.pins === 0) inactiveBytes += entry.bytes;
    while (inactiveBytes > Math.max(0, targetBytes)) {
      const victim = [...this.cache.entries()]
        .filter(([key, entry]) => entry.pins === 0 && !protectedKeys.has(key))
        .sort((a, b) => a[1].lastUse - b[1].lastUse)[0];
      if (!victim) return;
      this.cache.delete(victim[0]);
      inactiveBytes -= victim[1].bytes;
    }
  }
}

let sharedProvider: SoundFontSampleProvider | null = null;

export function getSharedSoundFontSampleProvider(): SoundFontSampleProvider {
  sharedProvider ??= new SoundFontSampleProvider();
  return sharedProvider;
}

export function getSoundFontSampleProviderStats(): SoundFontSampleProviderStats {
  return getSharedSoundFontSampleProvider().getStats();
}

/** Test helper for isolating cache accounting across test cases. */
export function resetSharedSoundFontSampleProviderForTests(): void {
  sharedProvider?.reset();
  sharedProvider = null;
}

async function decodeCompressedSample(
  encoded: ArrayBuffer,
  sampleRate: number,
  audioContext: AudioContext | OfflineAudioContext,
): Promise<AudioBuffer> {
  if (audioContext.sampleRate === sampleRate && typeof audioContext.decodeAudioData === "function") {
    return audioContext.decodeAudioData(encoded);
  }
  const OfflineContext = globalThis.OfflineAudioContext;
  if (typeof OfflineContext !== "function") {
    throw new Error(`SF3 decoding at ${sampleRate} Hz requires OfflineAudioContext when the active audio context uses ${audioContext.sampleRate} Hz.`);
  }
  const decoderContext = new OfflineContext(1, 1, sampleRate);
  return decoderContext.decodeAudioData(encoded);
}

function abortError(): DOMException {
  return new DOMException("SoundFont sample preparation was cancelled.", "AbortError");
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function readBlobRange(blob: Blob, start: number, end: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const expectedBytes = end - start;
  const result = new Uint8Array(expectedBytes);
  const reader = blob.slice(start, end).stream().getReader();
  const cancelRead = () => { void reader.cancel(); };
  signal.addEventListener("abort", cancelRead, { once: true });
  let offset = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || offset + value.byteLength > expectedBytes) {
        throw new Error(`SoundFont range read returned more than ${expectedBytes} bytes.`);
      }
      result.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancelRead);
    try { reader.releaseLock(); } catch { /* The stream may have been cancelled. */ }
  }
  if (signal.aborted) throw abortError();
  if (offset !== expectedBytes) {
    throw new Error(`SoundFont range read returned ${offset} bytes; expected ${expectedBytes}.`);
  }
  return result.buffer;
}
