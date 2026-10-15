import { parseSf2 } from "./sf2Parser.ts";
import type { Sf2SoundFont } from "./types.ts";

self.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer }>) => {
  try {
    const parsed = parseSf2(event.data.buffer);
    const raw = parsed.rawSampleData ?? new Int16Array(0);
    const rawSampleBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const soundFont = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== "rawSampleData"),
    ) as Omit<Sf2SoundFont, "rawSampleData">;
    self.postMessage({ soundFont, rawSampleBuffer }, { transfer: [rawSampleBuffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Unable to parse this SoundFont." });
  }
};
