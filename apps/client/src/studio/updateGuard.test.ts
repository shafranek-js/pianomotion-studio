import { describe, expect, it, vi } from "vitest";
import type { SaveSession } from "../player/saveResult";
import { applyGuardedStudioUpdate } from "./updateGuard";

function setup() {
  const identity = { projectId: "project", revision: 3, changeToken: 5 };
  const state = { ...identity, dirty: false, pending: false };
  const session: SaveSession = {
    getState: () => ({ ...state }),
    save: vi.fn(async () => ({ status: "committed" as const, identity: { ...identity } })),
  };
  const guard = { getSession: () => session, hasProject: () => true,
    flushRecovery: vi.fn(async () => {}), activate: vi.fn() };
  return { state, session, guard };
}

describe("studio update save barrier", () => {
  it("activates only after committed project and recovery writes", async () => {
    const { guard } = setup();
    guard.flushRecovery.mockImplementation(async () => { expect(guard.activate).not.toHaveBeenCalled(); });
    await applyGuardedStudioUpdate(guard);
    expect(guard.activate).toHaveBeenCalledOnce();
  });

  it.each(["blocked", "failed"] as const)("does not activate after a %s save", async (status) => {
    const { session, guard } = setup();
    session.save = vi.fn(async () => ({ status, reason: "Commit was not completed", identity: session.getState() }));
    await expect(applyGuardedStudioUpdate(guard)).rejects.toThrow("Commit was not completed");
    expect(guard.activate).not.toHaveBeenCalled();
  });

  it("preserves edits made while recovery is being committed", async () => {
    const { state, guard } = setup();
    guard.flushRecovery.mockImplementation(async () => { state.changeToken++; state.dirty = true; });
    await expect(applyGuardedStudioUpdate(guard)).rejects.toThrow("project changed");
    expect(guard.activate).not.toHaveBeenCalled();
  });

  it("does not activate after recovery storage failure", async () => {
    const { guard } = setup();
    guard.flushRecovery.mockRejectedValue(new Error("QuotaExceededError"));
    await expect(applyGuardedStudioUpdate(guard)).rejects.toThrow("QuotaExceededError");
    expect(guard.activate).not.toHaveBeenCalled();
  });
});
