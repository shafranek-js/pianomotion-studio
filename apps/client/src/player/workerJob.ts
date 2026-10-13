import { M1EngineMessageSchema, type M1EngineMessage } from "@handthesia/contracts";
import { createM1AnalysisWorker } from "../m1WorkerClient";

type JobIdentity = { requestId: string; projectId: string; revision: number; engineVersion: string };

/** Own one real Worker until the matching terminal response, abort, or timeout. */
export function runWorkerJob<T>(
  request: JobIdentity,
  send: (worker: Worker) => void,
  accept: (message: M1EngineMessage) => T | undefined,
  signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Superseded calculation", "AbortError")); return; }
    const worker = createM1AnalysisWorker();
    let settled = false;
    const finish = (value?: T, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(undefined, new DOMException("Superseded calculation", "AbortError"));
    const timer = setTimeout(() => finish(undefined, new Error("Calculation exceeded 180 seconds; retry to start a new Worker.")), 180_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => finish(undefined, new Error(event.message || "Calculation Worker crashed."));
    worker.onmessageerror = () => finish(undefined, new Error("Calculation Worker response could not be decoded."));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      try {
        const message = M1EngineMessageSchema.parse(event.data);
        if (message.requestId !== request.requestId || message.projectId !== request.projectId ||
          message.revision !== request.revision || message.engineVersion !== request.engineVersion) return;
        if (message.type === "worker-error") { finish(undefined, new Error(message.error.message)); return; }
        if (message.type === "progress") { onProgress?.(message.message ?? message.stage); return; }
        const accepted = accept(message);
        if (accepted !== undefined) finish(accepted);
      } catch (error) { finish(undefined, error); }
    };
    try { send(worker); } catch (error) { finish(undefined, error); }
  });
}
