import { isCommittedSaveCurrent, type SaveSession } from "../player/saveResult";

export interface StudioUpdateGuard {
  getSession(): SaveSession | null;
  hasProject(): boolean;
  flushRecovery(): Promise<void>;
  activate(): void;
}

/** Activation is the final synchronous step after a committed, still-current save. */
export async function applyGuardedStudioUpdate(guard: StudioUpdateGuard): Promise<void> {
  const session = guard.getSession();
  if (!session && guard.hasProject()) throw new Error("The current project is not ready to save.");
  const result = session ? await session.save() : null;
  if (result && result.status !== "committed") throw new Error(result.reason);
  await guard.flushRecovery();
  if (session) {
    if (guard.getSession() !== session || !result || !isCommittedSaveCurrent(session, result)) {
      throw new Error("The project changed while saving. Save the latest changes before updating.");
    }
  } else if (guard.hasProject() || guard.getSession()) {
    throw new Error("A project was opened while preparing the update. Save it before updating.");
  }
  guard.activate();
}
