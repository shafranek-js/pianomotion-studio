import { describe, expect, it } from "vitest";
import { SessionOperationLifecycle } from "./sessionOperation";

describe("SessionOperationLifecycle", () => {
  it("aborts startup as soon as an explicit open takes ownership", () => {
    const lifecycle = new SessionOperationLifecycle();
    const bootstrap = lifecycle.begin("bootstrap");

    const open = lifecycle.begin("open");

    expect(bootstrap.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(bootstrap)).toBe(false);
    expect(lifecycle.isCurrent(open)).toBe(true);
    expect(open.generation).toBeGreaterThan(bootstrap.generation);
  });

  it("invalidates a canceled open so a late completion cannot commit", () => {
    const lifecycle = new SessionOperationLifecycle();
    const bootstrap = lifecycle.begin("bootstrap");
    const open = lifecycle.begin("open");

    lifecycle.cancel(open);

    expect(open.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(open)).toBe(false);
    expect(lifecycle.isCurrent(bootstrap)).toBe(false);
    expect(lifecycle.isPending()).toBe(false);
  });

  it("does not let an old effect cleanup cancel the operation that replaced it", () => {
    const lifecycle = new SessionOperationLifecycle();
    const bootstrap = lifecycle.begin("bootstrap");
    const open = lifecycle.begin("open");

    lifecycle.cancel(bootstrap);

    expect(lifecycle.isCurrent(open)).toBe(true);
    expect(open.signal.aborted).toBe(false);
  });

  it("does not let an old cancel clear the current open or its busy state", () => {
    const lifecycle = new SessionOperationLifecycle();
    const analysisA = lifecycle.begin("open");
    const openB = lifecycle.begin("open");

    lifecycle.cancel(analysisA);

    // B's begin already aborted A; cancelling A must not touch B's busy state.
    expect(analysisA.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(openB)).toBe(true);
    expect(lifecycle.isBusy()).toBe(true);

    lifecycle.finish(openB);
    expect(lifecycle.isBusy()).toBe(false);
  });

  it("keeps busy owned by the newest open when the old analysis finishes", () => {
    const lifecycle = new SessionOperationLifecycle();
    const analysisA = lifecycle.begin("open");
    const openB = lifecycle.begin("open");

    expect(lifecycle.isBusy()).toBe(true);

    // A completes after B took ownership: B stays current and busy.
    lifecycle.finish(analysisA);
    expect(lifecycle.isCurrent(openB)).toBe(true);
    expect(lifecycle.isBusy()).toBe(true);

    lifecycle.finish(openB);
    expect(lifecycle.isBusy()).toBe(false);
    expect(lifecycle.isPending()).toBe(false);
  });

  it("releases busy when the newest open ends early and ignores the old finish", () => {
    const lifecycle = new SessionOperationLifecycle();
    const analysisA = lifecycle.begin("open");
    const openB = lifecycle.begin("open");

    // B exits before it ever reaches analysis (legacy/error path).
    lifecycle.finish(openB);
    expect(lifecycle.isBusy()).toBe(false);
    expect(lifecycle.isPending()).toBe(false);

    // A's late completion must not re-open or change the released state.
    lifecycle.finish(analysisA);
    expect(lifecycle.isBusy()).toBe(false);
    expect(lifecycle.isPending()).toBe(false);
  });

  it("clears busy on cancel and keeps it for an open started afterwards", () => {
    const lifecycle = new SessionOperationLifecycle();
    const analysisA = lifecycle.begin("open");
    const openB = lifecycle.begin("open");

    lifecycle.cancel(openB);
    expect(lifecycle.isBusy()).toBe(false);
    expect(lifecycle.isCurrent(openB)).toBe(false);

    const openC = lifecycle.begin("open");
    lifecycle.finish(analysisA);
    expect(lifecycle.isCurrent(openC)).toBe(true);
    expect(lifecycle.isBusy()).toBe(true);

    lifecycle.finish(openC);
    expect(lifecycle.isBusy()).toBe(false);
  });
});
