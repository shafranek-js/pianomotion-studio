interface BackingPreparationOptions {
  prepare: () => Promise<void>;
  dropBuiltinFallback: (error: unknown) => void;
  canRetry: () => boolean;
  signal: AbortSignal;
}

/** One retry budget shared by the initial preparation and all handover windows. */
export function createBackingPreparationWithBuiltinFallback(options: BackingPreparationOptions): () => Promise<void> {
  let retried = false;
  return async () => {
    try {
      await options.prepare();
    } catch (error) {
      const aborted = typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
      if (retried || aborted || options.signal.aborted || !options.canRetry()) throw error;
      retried = true;
      options.dropBuiltinFallback(error);
      // A primary-bank preparation error must still reject the candidate pair.
      await options.prepare();
    }
  };
}
