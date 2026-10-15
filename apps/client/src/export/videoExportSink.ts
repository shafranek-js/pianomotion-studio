import { StreamTarget, type StreamTargetChunk } from "mediabunny";

export const MAX_VIDEO_BLOB_BYTES = 128 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;

interface FileWriterLike {
  write(data: StreamTargetChunk): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface SaveFileHandleLike {
  name: string;
  createWritable(): Promise<FileWriterLike>;
}

export interface VideoOutputSink {
  target: StreamTarget;
  mode: "file" | "bounded-blob";
  getSizeBytes(): number;
  getBlob(): Blob | null;
  isClosed(): boolean;
  abort(reason?: unknown): Promise<void>;
}

export class BoundedBlobAccumulator {
  private bytes: Uint8Array;
  private sizeBytes = 0;
  private blob: Blob | null = null;
  private aborted = false;

  public constructor(private readonly mimeType: string, public readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_VIDEO_BLOB_BYTES) {
      throw new RangeError(`Blob output limit must be between 1 byte and ${MAX_VIDEO_BLOB_BYTES} bytes.`);
    }
    this.bytes = new Uint8Array(Math.min(STREAM_CHUNK_BYTES, maxBytes));
  }

  public write(position: number, data: Uint8Array): void {
    if (this.aborted) throw new Error("Video Blob output was canceled.");
    const end = position + data.byteLength;
    if (!Number.isSafeInteger(end) || position < 0) throw new RangeError("Video muxer wrote an invalid output range.");
    if (end > this.maxBytes) throw new RangeError(`Video exceeds the ${this.maxBytes}-byte in-memory output limit.`);
    if (end > this.bytes.byteLength) {
      let capacity = this.bytes.byteLength;
      while (capacity < end) capacity = Math.min(this.maxBytes, Math.max(end, capacity * 2));
      const next = new Uint8Array(capacity);
      next.set(this.bytes);
      this.bytes = next;
    }
    this.bytes.set(data, position);
    this.sizeBytes = Math.max(this.sizeBytes, end);
  }

  public finalize(): Blob {
    if (this.aborted) throw new DOMException("Video export canceled", "AbortError");
    this.blob = new Blob([this.bytes.slice(0, this.sizeBytes)], { type: this.mimeType });
    return this.blob;
  }

  public abort(): void {
    this.aborted = true;
    this.blob = null;
    this.sizeBytes = 0;
    this.bytes = new Uint8Array(0);
  }

  public get size(): number { return this.sizeBytes; }
  public get result(): Blob | null { return this.blob; }
}

export function beginSaveFilePicker(filename: string, mimeType: string): Promise<SaveFileHandleLike> | null {
  if (typeof window === "undefined") return null;
  const picker = (window as Window & {
    showSaveFilePicker?: (options: unknown) => Promise<SaveFileHandleLike>;
  }).showSaveFilePicker;
  if (typeof picker !== "function") return null;
  return picker.call(window, {
    suggestedName: filename,
    types: [{
      description: mimeType === "video/mp4" ? "MP4 video" : "WebM video",
      accept: { [mimeType]: [mimeType === "video/mp4" ? ".mp4" : ".webm"] },
    }],
  });
}

export async function createFileVideoSink(handle: SaveFileHandleLike): Promise<VideoOutputSink> {
  const writer = await handle.createWritable();
  let sizeBytes = 0;
  let closed = false;
  let aborted = false;
  let abortPromise: Promise<void> | null = null;
  const writable = new WritableStream<StreamTargetChunk>({
    write: async (chunk) => {
      if (aborted) throw new Error("Video file output was canceled.");
      await writer.write(chunk);
      sizeBytes = Math.max(sizeBytes, chunk.position + chunk.data.byteLength);
    },
    close: async () => {
      if (aborted) {
        await writer.abort(new DOMException("Video export canceled", "AbortError"));
      } else {
        await writer.close();
        closed = true;
      }
    },
    abort: async (reason) => {
      aborted = true;
      if (!closed) await writer.abort(reason);
    },
  });
  const target = new StreamTarget(writable, { chunked: true, chunkSize: STREAM_CHUNK_BYTES });
  return {
    target,
    mode: "file",
    getSizeBytes: () => sizeBytes,
    getBlob: () => null,
    isClosed: () => closed,
    abort: async (reason) => {
      aborted = true;
      if (!closed && !abortPromise) {
        abortPromise = writer.abort(reason).catch(() => {});
      }
      await abortPromise;
    },
  };
}

export function createBoundedBlobVideoSink(
  mimeType: string,
  maxBytes = MAX_VIDEO_BLOB_BYTES,
): VideoOutputSink {
  const accumulator = new BoundedBlobAccumulator(mimeType, maxBytes);
  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => {
      accumulator.write(chunk.position, chunk.data);
    },
    close: () => { accumulator.finalize(); },
    abort: () => {
      accumulator.abort();
    },
  });
  const target = new StreamTarget(writable, { chunked: true, chunkSize: STREAM_CHUNK_BYTES });
  return {
    target,
    mode: "bounded-blob",
    getSizeBytes: () => accumulator.size,
    getBlob: () => accumulator.result,
    isClosed: () => accumulator.result !== null,
    abort: async () => {
      accumulator.abort();
      try { await writable.abort(); } catch { /* writer may already be closed */ }
    },
  };
}
