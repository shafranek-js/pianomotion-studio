import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeProjectDb,
  IDB_OPEN_BLOCKED_TIMEOUT_MS,
  openProjectDb,
  setIndexedDBFactory,
} from "./projectDb.ts";

type FakeOpenRequest = {
  result: IDBDatabase;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
  onupgradeneeded: (() => void) | null;
};

function fakeDatabase() {
  const close = vi.fn();
  return { close, onversionchange: null, onclose: null } as unknown as IDBDatabase & { close: ReturnType<typeof vi.fn> };
}

class FakeFactory {
  requests: FakeOpenRequest[] = [];

  open = vi.fn(() => {
    const request: FakeOpenRequest = {
      result: fakeDatabase(),
      error: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
    };
    this.requests.push(request);
    return request as unknown as IDBOpenDBRequest;
  });
}

function install(factory: FakeFactory): void {
  setIndexedDBFactory(factory as unknown as IDBFactory);
}

afterEach(() => {
  closeProjectDb();
  setIndexedDBFactory(null);
  vi.useRealTimers();
});

describe("CLI-1 IndexedDB open settlement", () => {
  it("rejects a blocked open after a bounded wait and closes a late connection", async () => {
    vi.useFakeTimers();
    const factory = new FakeFactory();
    install(factory);

    const pending = openProjectDb();
    const rejection = expect(pending).rejects.toThrow(/Close other tabs and retry/);
    factory.requests[0]!.onblocked?.();
    await vi.advanceTimersByTimeAsync(IDB_OPEN_BLOCKED_TIMEOUT_MS);

    await rejection;

    // A success arriving after the timeout must not become the cached instance.
    const late = factory.requests[0]!.result as unknown as { close: ReturnType<typeof vi.fn> };
    factory.requests[0]!.onsuccess?.();
    expect(late.close).toHaveBeenCalledTimes(1);

    // The failed attempt leaves no cached connection, so a retry opens again.
    const retry = openProjectDb();
    expect(factory.requests).toHaveLength(2);
    factory.requests[1]!.onsuccess?.();
    await expect(retry).resolves.toBe(factory.requests[1]!.result);
  });

  it("clears the blocked timer when the connection succeeds in time", async () => {
    vi.useFakeTimers();
    const factory = new FakeFactory();
    install(factory);

    const pending = openProjectDb();
    factory.requests[0]!.onblocked?.();
    factory.requests[0]!.onsuccess?.();

    await expect(pending).resolves.toBe(factory.requests[0]!.result);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(IDB_OPEN_BLOCKED_TIMEOUT_MS);
  });

  it("clears the blocked timer when the request errors first", async () => {
    vi.useFakeTimers();
    const factory = new FakeFactory();
    install(factory);

    const pending = openProjectDb();
    const failure = expect(pending).rejects.toThrow("blocked open failed");
    factory.requests[0]!.onblocked?.();
    factory.requests[0]!.error = new DOMException("blocked open failed", "UnknownError");
    factory.requests[0]!.onerror?.();
    await failure;

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(IDB_OPEN_BLOCKED_TIMEOUT_MS);
    expect(factory.requests).toHaveLength(1);
  });

  it("rejects an open error and succeeds on the next attempt", async () => {
    const factory = new FakeFactory();
    install(factory);

    const failed = openProjectDb();
    const failure = expect(failed).rejects.toThrow("open failed");
    factory.requests[0]!.error = new DOMException("open failed", "UnknownError");
    factory.requests[0]!.onerror?.();
    await failure;

    const retry = openProjectDb();
    expect(factory.requests).toHaveLength(2);
    factory.requests[1]!.onsuccess?.();
    await expect(retry).resolves.toBe(factory.requests[1]!.result);
  });
});
