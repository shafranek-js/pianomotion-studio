/**
 * Progress context adapter for the synchronous batch core.
 *
 * Calculations keep clean call sites while progress and cancellation
 * are managed by the worker lifecycle.
 */

export type ProgressCallback = (fraction: number, message: string) => void;

let _globalProgressCallback: ProgressCallback | null = null;

export function setProgressCallback(callback: ProgressCallback | null | undefined): void {
  _globalProgressCallback = callback ?? null;
}

export const set_progress_callback = setProgressCallback;

export function reportProgress(fraction: number, message = ""): void {
  const cb = _globalProgressCallback;
  if (cb !== null) {
    try {
      cb(Number(fraction), String(message));
    } catch {
      // Ignore callback errors to match Python api._report_progress
    }
  }
}

export const _report_progress = reportProgress;

export interface StageContext {
  close(): void;
}

export function stage<T>(start: number, end: number, fn: () => T): T;
export function stage(start?: number, end?: number): StageContext;
export function stage<T>(_start = 0.0, _end = 1.0, fn?: () => T): T | StageContext {
  if (typeof fn === "function") {
    return fn();
  }
  return {
    close(): void {
      // No-op context exit
    },
  };
}

export function report(_value: number): null {
  return null;
}
