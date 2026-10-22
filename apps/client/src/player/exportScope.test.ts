import { describe, expect, it } from "vitest";
import { ExportOperationScope, runScopedExport } from "./exportScope";

describe("ExportOperationScope", () => {
  it("aborts the previous export when a newer one starts", () => {
    const scope = new ExportOperationScope();
    const first = scope.begin();
    const second = scope.begin();

    expect(first.controller.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(scope.isActive()).toBe(true);
  });

  it("does not let a stale finish clear the current export", () => {
    const scope = new ExportOperationScope();
    const first = scope.begin();
    const second = scope.begin();

    scope.finish(first.controller);

    expect(second.isCurrent()).toBe(true);
    expect(scope.isActive()).toBe(true);
  });

  it("cancels the current export without affecting a later one", () => {
    const scope = new ExportOperationScope();
    const first = scope.begin();
    scope.cancel();

    expect(first.controller.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(scope.isActive()).toBe(false);

    const second = scope.begin();
    expect(second.isCurrent()).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
  });

  it("finishes the current export exactly once", () => {
    const scope = new ExportOperationScope();
    const current = scope.begin();
    scope.finish(current.controller);

    expect(current.isCurrent()).toBe(false);
    expect(scope.isActive()).toBe(false);

    scope.finish(current.controller);
    expect(scope.isActive()).toBe(false);
  });

  it("does not commit a stale async preparation", async () => {
    const scope = new ExportOperationScope();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const committed: string[] = [];

    const stale = runScopedExport(scope, async () => {
      await gate;
      return "stale";
    }, value => committed.push(value));

    // A newer export takes ownership while the first preparation is pending.
    scope.begin();
    release();
    await expect(stale).resolves.toBe(false);
    expect(committed).toEqual([]);
  });

  it("commits a current async preparation", async () => {
    const scope = new ExportOperationScope();
    const committed: string[] = [];

    await expect(runScopedExport(scope, async () => "current", value => committed.push(value))).resolves.toBe(true);
    expect(committed).toEqual(["current"]);
  });
});
