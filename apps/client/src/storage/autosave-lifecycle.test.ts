import { describe, expect, it, vi } from "vitest";
import { registerAutosaveFlush } from "./autosave.ts";

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

describe("CLI-3 autosave lifecycle flush", () => {
  it("flushes on pagehide and only when the page becomes hidden", () => {
    const flush = vi.fn(async () => undefined);
    const windowTarget = new EventTarget();
    const documentTarget = new FakeDocument();
    const unregister = registerAutosaveFlush({ flush }, windowTarget, documentTarget);

    windowTarget.dispatchEvent(new Event("pagehide"));
    expect(flush).toHaveBeenCalledTimes(1);

    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalledTimes(1);

    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalledTimes(2);

    unregister();
    windowTarget.dispatchEvent(new Event("pagehide"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("does not leak a rejected flush during teardown", async () => {
    const flush = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    const windowTarget = new EventTarget();
    const documentTarget = new FakeDocument();
    const unregister = registerAutosaveFlush({ flush }, windowTarget, documentTarget);

    windowTarget.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();

    expect(flush).toHaveBeenCalledTimes(1);
    unregister();
  });
});
