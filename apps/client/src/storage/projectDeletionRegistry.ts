/**
 * Per-project deletion epochs prevent a save that began before a deletion from
 * re-enabling autosave when its continuation finishes after the delete.
 */
export class ProjectDeletionRegistry {
  private readonly epochs = new Map<string, number>();

  beginSave(projectId: string): number {
    return this.epochs.get(projectId) ?? 0;
  }

  markDeleted(projectId: string): void {
    this.epochs.set(projectId, (this.epochs.get(projectId) ?? 0) + 1);
  }

  canReenable(projectId: string, saveEpoch: number): boolean {
    return (this.epochs.get(projectId) ?? 0) === saveEpoch;
  }
}
