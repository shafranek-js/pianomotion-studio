import { parseSf2BlobMetadata } from "./sf2BlobParser.ts";
import type { Sf2Progress } from "./sf2Parser.ts";
import type { Sf2SoundFont } from "./types.ts";

interface ParseRequest {
  blob?: Blob;
  buffer?: ArrayBuffer;
}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  void (async () => {
    try {
      const input = event.data?.blob ?? (event.data?.buffer ? new Blob([event.data.buffer]) : null);
      if (!input) throw new Error("The parser worker received no file data.");
      const parsed = await parseSf2BlobMetadata(input, {
        onProgress: (progress: Sf2Progress) => self.postMessage({ progress }),
      });
      // Blob structured cloning carries the immutable backing source without
      // returning a second full PCM ArrayBuffer to the main thread.
      self.postMessage({ soundFont: parsed satisfies Sf2SoundFont });
    } catch (error) {
      self.postMessage({ error: error instanceof Error ? error.message : "Unable to parse this SoundFont." });
    }
  })();
};
