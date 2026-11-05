import { describe, expect, it, vi } from "vitest";
import { createBackingPreparationWithBuiltinFallback } from "./backingPreparation.ts";

function setup() {
  const prepare = vi.fn<() => Promise<void>>().mockResolvedValue();
  const dropBuiltinFallback = vi.fn();
  const canRetry = vi.fn(() => true);
  const controller = new AbortController();
  const run = createBackingPreparationWithBuiltinFallback({ prepare, dropBuiltinFallback, canRetry, signal: controller.signal });
  return { prepare, dropBuiltinFallback, canRetry, controller, run };
}

describe("backing preparation with an included GM fallback", () => {
  it("retries initial backing preparation once after dropping the failed GM tier", async () => {
    const { prepare, dropBuiltinFallback, run } = setup();
    const failure = new Error("Ogg sample could not be decoded");
    prepare.mockRejectedValueOnce(failure);
    await run();
    expect(dropBuiltinFallback).toHaveBeenCalledExactlyOnceWith(failure);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(dropBuiltinFallback.mock.invocationCallOrder[0]).toBeGreaterThan(prepare.mock.invocationCallOrder[0]!);
    expect(dropBuiltinFallback.mock.invocationCallOrder[0]).toBeLessThan(prepare.mock.invocationCallOrder[1]!);
  });

  it("also retries a failed handover window after initial preparation succeeded", async () => {
    const { prepare, dropBuiltinFallback, run } = setup();
    await run();
    const failure = new Error("A later GM sample failed");
    prepare.mockRejectedValueOnce(failure);
    await run();
    expect(dropBuiltinFallback).toHaveBeenCalledExactlyOnceWith(failure);
    expect(prepare).toHaveBeenCalledTimes(3);
    // A second later failure cannot re-enter the already discarded GM tier.
    const primaryFailure = new Error("Selected bank sample failed");
    prepare.mockRejectedValueOnce(primaryFailure);
    await expect(run()).rejects.toBe(primaryFailure);
    expect(dropBuiltinFallback).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it("propagates an unusable primary bank on the one retry without looping", async () => {
    const { prepare, dropBuiltinFallback, run } = setup();
    const failure = new Error("Selected bank sample failed");
    prepare.mockRejectedValue(failure);
    await expect(run()).rejects.toBe(failure);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(dropBuiltinFallback).toHaveBeenCalledTimes(1);
  });

  it.each(["abort error", "aborted signal", "stale candidate", "no included tier"])("never retries for %s", async scenario => {
    const { prepare, dropBuiltinFallback, canRetry, controller, run } = setup();
    const failure = scenario === "abort error" ? new DOMException("Cancelled", "AbortError") : new Error("Preparation failed");
    if (scenario === "aborted signal") controller.abort();
    if (scenario === "stale candidate" || scenario === "no included tier") canRetry.mockReturnValue(false);
    prepare.mockRejectedValue(failure);
    await expect(run()).rejects.toBe(failure);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(dropBuiltinFallback).not.toHaveBeenCalled();
  });
});
