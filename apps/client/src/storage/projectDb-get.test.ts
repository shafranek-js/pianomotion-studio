import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeProjectDb,
  getProject,
  openProjectDb,
  setIndexedDBFactory,
  type SavedProject,
} from "./projectDb.ts";

type Handler = (() => void) | null;

type FakegetRequest = {
  result?: unknown;
  error: DOMException | null;
  onsuccess: Handler;
  onerror: Handler;
};

type FakeTransaction = {
  error: DOMException | null;
  onerror: Handler;
  onabort: Handler;
  oncomplete: Handler;
  objectStore: () => { get: () => FakegetRequest };
};

const project: SavedProject = {
  projectId: "cli1-read",
  name: "CLI-1 read",
  updatedAt: 1,
  document: {
    schemaVersion: 1,
    projectId: "cli1-read",
    revision: 0,
    title: "CLI-1",
    durationSeconds: 1,
    tracks: [{ trackId: "track", instrumentIndex: 0, name: "Piano", program: 0, hand: "right" }],
    notes: [{
      noteId: "note",
      trackId: "track",
      pitch: 60,
      velocity: 80,
      startSeconds: 0,
      endSeconds: 0.5,
      hand: "right",
      finger: 1,
      glissando: false,
    }],
    tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500_000, eventOrdinal: 0 }],
    pedalControls: [],
  },
};

type Harness = {
  requests: FakegetRequest[];
  transactions: FakeTransaction[];
  open: () => Promise<void>;
};

function createHarness(): Harness {
  const requests: FakegetRequest[] = [];
  const transactions: FakeTransaction[] = [];
  const db = {
    close: vi.fn(),
    onversionchange: null,
    onclose: null,
    transaction: vi.fn(() => {
      const request: FakegetRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
      requests.push(request);
      const tx: FakeTransaction = {
        error: null,
        onerror: null,
        onabort: null,
        oncomplete: null,
        objectStore: () => ({ get: () => request }),
      };
      transactions.push(tx);
      return tx;
    }),
  } as unknown as IDBDatabase;

  let openRequest: {
    result: IDBDatabase;
    error: DOMException | null;
    onsuccess: Handler;
    onerror: Handler;
    onblocked: Handler;
    onupgradeneeded: Handler;
  } | null = null;
  const factory = {
    open: vi.fn(() => {
      openRequest = {
        result: db,
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
      };
      return openRequest as unknown as IDBOpenDBRequest;
    }),
  };

  return {
    requests,
    transactions,
    open: async () => {
      setIndexedDBFactory(factory as unknown as IDBFactory);
      const pending = openProjectDb();
      openRequest!.onsuccess?.();
      await pending;
    },
  };
}

function startRead(harness: Harness): { pending: Promise<SavedProject | null>; ready: Promise<void> } {
  const expectedRequests = harness.requests.length + 1;
  const pending = getProject(project.projectId);
  const ready = (async () => {
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.requests).toHaveLength(expectedRequests);
  })();
  return { pending, ready };
}

afterEach(() => {
  closeProjectDb();
  setIndexedDBFactory(null);
});

describe("CLI-1 getProject settlement", () => {
  const triggers: Array<[string, (harness: Harness) => void, RegExp]> = [
    ["request.onerror", (harness) => {
      harness.requests[0]!.error = new DOMException("read failed", "UnknownError");
      harness.requests[0]!.onerror?.();
    }, /read failed/],
    ["tx.onerror", (harness) => {
      harness.transactions[0]!.error = new DOMException("tx failed", "UnknownError");
      harness.transactions[0]!.onerror?.();
    }, /tx failed/],
    ["tx.onabort", (harness) => {
      harness.transactions[0]!.error = new DOMException("tx aborted", "AbortError");
      harness.transactions[0]!.onabort?.();
    }, /tx aborted/],
  ];

  it.each(triggers)("%s rejects before success and a later read succeeds", async (_name, trigger, pattern) => {
    const harness = createHarness();
    await harness.open();

    const { pending, ready } = startRead(harness);
    await ready;
    const failure = expect(pending).rejects.toThrow(pattern);
    trigger(harness);
    await failure;

    const retryRead = startRead(harness);
    await retryRead.ready;
    harness.requests[1]!.result = project;
    harness.requests[1]!.onsuccess?.();
    await expect(retryRead.pending).resolves.toMatchObject({ projectId: project.projectId });
  });

  it("ignores late and repeated events after a rejection", async () => {
    const harness = createHarness();
    await harness.open();

    const { pending, ready } = startRead(harness);
    await ready;
    const failure = expect(pending).rejects.toThrow("read failed");
    harness.requests[0]!.error = new DOMException("read failed", "UnknownError");
    harness.requests[0]!.onerror?.();
    await failure;

    // Late success, duplicate request error, transaction error and abort must
    // not resolve the already rejected promise or start another read.
    harness.requests[0]!.result = project;
    harness.requests[0]!.onsuccess?.();
    harness.requests[0]!.onerror?.();
    harness.transactions[0]!.onerror?.();
    harness.transactions[0]!.onabort?.();
    await Promise.resolve();

    expect(harness.requests).toHaveLength(1);
    expect(harness.transactions).toHaveLength(1);
  });
});
