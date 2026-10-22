/**
 * Owns the one in-flight fingered-MIDI export. A newer export or a project
 * change aborts the previous one, and a stale completion must not download or
 * overwrite the status.
 */
export class ExportOperationScope {
  private current: AbortController | null = null;

  begin(): { controller: AbortController; isCurrent: () => boolean } {
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    return {
      controller,
      isCurrent: () => this.current === controller && !controller.signal.aborted,
    };
  }

  finish(controller: AbortController): void {
    if (this.current === controller) this.current = null;
  }

  cancel(): void {
    const current = this.current;
    this.current = null;
    current?.abort();
  }

  isActive(): boolean {
    return this.current !== null && !this.current.signal.aborted;
  }
}

/**
 * Runs an async export preparation and commits only if its scope generation is
 * still current. Stale preparations resolve false without downloading or
 * changing status; current failures propagate to the caller.
 */
export async function runScopedExport<T>(
  scope: ExportOperationScope,
  prepare: (signal: AbortSignal) => Promise<T>,
  commit: (value: T) => void,
): Promise<boolean> {
  const { controller, isCurrent } = scope.begin();
  try {
    const value = await prepare(controller.signal);
    if (!isCurrent()) return false;
    commit(value);
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    throw error;
  } finally {
    scope.finish(controller);
  }
}
