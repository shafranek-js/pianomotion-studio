import { loadBuiltinSoundFont, type BuiltinSoundFontAsset } from "./builtinSoundfont.ts";
import { parseSf2Async } from "./sf2Parser.ts";
import type { Sf2SoundFont } from "./types.ts";

export interface ParsedBuiltinSoundFont {
  asset: BuiltinSoundFontAsset;
  soundFont: Sf2SoundFont;
}

interface PendingLoad {
  controller: AbortController;
  promise: Promise<ParsedBuiltinSoundFont>;
  consumers: number;
  settled: boolean;
}

let cached: ParsedBuiltinSoundFont | undefined;
let pending: PendingLoad | undefined;

function abortError(): DOMException {
  return new DOMException("Built-in SoundFont loading was cancelled.", "AbortError");
}

/** One verified, parsed immutable release bank per tab, shared by piano and backing. */
export function loadParsedBuiltinSoundFont(signal?: AbortSignal): Promise<ParsedBuiltinSoundFont> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    const controller = new AbortController();
    const entry: PendingLoad = {
      controller,
      consumers: 0,
      settled: false,
      promise: Promise.resolve().then(async () => {
        const asset = await loadBuiltinSoundFont({ signal: controller.signal });
        const soundFont = await parseSf2Async(asset.data, { signal: controller.signal });
        if (controller.signal.aborted) throw abortError();
        if (soundFont.sampleSource) soundFont.sampleSource.assetId = asset.id;
        const result = { asset, soundFont };
        cached = result;
        return result;
      }).finally(() => {
        entry.settled = true;
        if (pending === entry) pending = undefined;
      }),
    };
    pending = entry;
  }
  const entry = pending;
  entry.consumers++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (action: () => void) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      entry.consumers--;
      if (entry.consumers === 0 && !entry.settled) {
        entry.controller.abort();
        if (pending === entry) pending = undefined;
      }
      action();
    };
    const abort = () => finish(() => reject(abortError()));
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}
