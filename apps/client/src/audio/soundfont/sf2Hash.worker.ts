import { createSHA256 } from "hash-wasm";
import type { Sf2Progress } from "./sf2Parser.ts";

self.onmessage = (event: MessageEvent<{ blob: Blob }>) => {
  void (async () => {
    try {
      const blob = event.data?.blob;
      if (!(blob instanceof Blob)) throw new Error("The hash worker received no file data.");
      const hasher = await createSHA256();
      hasher.init();
      const chunkSize = 4 * 1024 * 1024;
      let loadedBytes = 0;
      while (loadedBytes < blob.size) {
        const end = Math.min(blob.size, loadedBytes + chunkSize);
        const bytes = new Uint8Array(await blob.slice(loadedBytes, end).arrayBuffer());
        hasher.update(bytes);
        loadedBytes = end;
        const progress: Sf2Progress = { phase: "hashing", loadedBytes, totalBytes: blob.size };
        self.postMessage({ progress });
      }
      self.postMessage({ digest: hasher.digest("hex") });
    } catch (error) {
      self.postMessage({ error: error instanceof Error ? error.message : "Unable to hash this SoundFont." });
    }
  })();
};
