export type SessionOperationKind = "bootstrap" | "open";

export interface SessionOperation {
  readonly generation: number;
  readonly kind: SessionOperationKind;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
}

/** Owns the one startup/open operation that is allowed to commit session state. */
export class SessionOperationLifecycle {
  private generation = 0;
  private current: SessionOperation | null = null;
  /** Generation that currently owns the open-busy state, if any. */
  private busyGeneration: number | null = null;

  begin(kind: SessionOperationKind): SessionOperation {
    this.current?.controller.abort();
    const controller = new AbortController();
    const operation: SessionOperation = {
      generation: ++this.generation,
      kind,
      controller,
      signal: controller.signal,
    };
    this.current = operation;
    this.busyGeneration = kind === "open" ? operation.generation : null;
    return operation;
  }

  isCurrent(operation: SessionOperation): boolean {
    return this.current === operation && !operation.signal.aborted;
  }

  /** True while the current open operation owns the busy state. */
  isBusy(): boolean {
    return this.busyGeneration !== null;
  }

  finish(operation: SessionOperation): void {
    if (this.current !== operation) return;
    this.current = null;
    if (this.busyGeneration === operation.generation) this.busyGeneration = null;
  }

  cancel(operation?: SessionOperation): void {
    if (operation && this.current !== operation) return;
    if (this.current !== null && this.busyGeneration === this.current.generation) {
      this.busyGeneration = null;
    }
    this.current?.controller.abort();
    this.current = null;
    this.generation += 1;
  }

  isPending(): boolean {
    return this.current !== null;
  }

  getGeneration(): number {
    return this.generation;
  }
}
