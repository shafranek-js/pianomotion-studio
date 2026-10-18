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
});
