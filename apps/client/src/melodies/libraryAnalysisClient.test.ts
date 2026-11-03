import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeLibraryBytes } from "./libraryAnalysisClient.ts";

interface WorkerRequest {
  type: "analyze";
  requestId: string;
  name: string;
  bytes: ArrayBuffer;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  request?: WorkerRequest;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: WorkerRequest): void {
    this.request = message;
  }

  terminate(): void {
    this.terminated = true;
  }

  send(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

function validResult(requestId: string) {
  const midiBytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64]).buffer;
  return {
    type: "result",
    requestId,
    result: {
      midiBytes,
      title: "Local",
      sourceFormat: "midi",
      durationSeconds: 1.25,
      noteCount: 2,
      difficultyScore: 3.4,
      difficultyTier: "Beginner",
      previewNotes: [
        {
          noteId: "note-1",
          pitch: 60,
          velocity: 90,
          startSeconds: 0,
          endSeconds: 0.5,
        },
      ],
    },
  };
}

function installFakeWorker(): void {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
}

describe("library analysis client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("runs one worker at a time and returns validated result data", async () => {
    installFakeWorker();
    const progress: string[] = [];
    const first = analyzeLibraryBytes(
      { name: "first.mid", bytes: new Uint8Array([1, 2]) },
      { onProgress: (message) => progress.push(message) },
    );
    const second = analyzeLibraryBytes({
      name: "second.mid",
      bytes: new Uint8Array([3, 4]),
    });

    expect(FakeWorker.instances).toHaveLength(1);
    expect(progress).toContain("Analyzing melody in background…");
    expect(FakeWorker.instances[0]!.request?.name).toBe("first.mid");

    const firstWorker = FakeWorker.instances[0]!;
    firstWorker.send({
      type: "progress",
      requestId: firstWorker.request!.requestId,
      message: "Converting score…",
    });
    firstWorker.send(validResult(firstWorker.request!.requestId));
    await expect(first).resolves.toMatchObject({
      title: "Local",
      durationSeconds: 1.25,
      noteCount: 2,
      difficultyScore: 3.4,
      difficultyTier: "Beginner",
      previewNotes: [{ pitch: 60 }],
    });

    expect(firstWorker.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1]!.request?.name).toBe("second.mid");
    const secondWorker = FakeWorker.instances[1]!;
    secondWorker.send(validResult(secondWorker.request!.requestId));
    await expect(second).resolves.toMatchObject({ noteCount: 2 });
  });

  it("terminates an active worker and rejects a cancelled queued request", async () => {
    installFakeWorker();
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = analyzeLibraryBytes(
      { name: "active.mid", bytes: new Uint8Array([1]) },
      { signal: activeController.signal },
    );
    const queued = analyzeLibraryBytes(
      { name: "queued.mid", bytes: new Uint8Array([2]) },
      { signal: queuedController.signal },
    );
    const worker = FakeWorker.instances[0]!;

    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances).toHaveLength(1);

    activeController.abort();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(true);
  });

  it("cleans up the worker on conversion failures and rejects oversized queues", async () => {
    installFakeWorker();
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const jobs = controllers.slice(0, 5).map((controller, index) =>
      analyzeLibraryBytes(
        { name: `${index}.mid`, bytes: new Uint8Array([index + 1]) },
        { signal: controller.signal },
      ),
    );
    const rejectedByLimit = analyzeLibraryBytes({
      name: "overflow.mid",
      bytes: new Uint8Array([9]),
    });
    await expect(rejectedByLimit).rejects.toThrow(/queue is full/i);

    const activeWorker = FakeWorker.instances[0]!;
    activeWorker.send({
      type: "error",
      requestId: activeWorker.request!.requestId,
      error: { name: "Error", message: "Malformed score" },
    });
    await expect(jobs[0]).rejects.toThrow("Malformed score");
    expect(activeWorker.terminated).toBe(true);

    for (const controller of controllers.slice(1)) controller.abort();
    await Promise.all(jobs.slice(1).map((job) => expect(job).rejects.toMatchObject({ name: "AbortError" })));
  });
});
