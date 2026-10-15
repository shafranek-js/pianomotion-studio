export interface SaveIdentity {
  projectId: string;
  revision: number;
  /** Advances for every musical edit, including edits made during a commit. */
  changeToken: number;
}

export type SaveResult =
  | { status: "committed"; identity: SaveIdentity }
  | { status: "blocked" | "failed"; reason: string; identity: SaveIdentity };

export interface SaveSession {
  save(): Promise<SaveResult>;
  getState(): SaveIdentity & { dirty: boolean; pending: boolean };
}

export function sameSaveIdentity(left: SaveIdentity, right: SaveIdentity): boolean {
  return left.projectId === right.projectId && left.revision === right.revision &&
    left.changeToken === right.changeToken;
}

export function isCommittedSaveCurrent(session: SaveSession, result: SaveResult): boolean {
  if (result.status !== "committed") return false;
  const current = session.getState();
  return !current.pending && !current.dirty && sameSaveIdentity(current, result.identity);
}
