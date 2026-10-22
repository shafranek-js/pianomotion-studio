import { describe, expect, it } from "vitest";
import { encodeBase64 } from "./packageExporter.ts";

function reference(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as unknown as {
    Buffer: { from(value: Uint8Array): { toString(encoding: string): string } };
  }).Buffer;
  return nodeBuffer.from(bytes).toString("base64");
}

describe("CLI-5 package base64 encoding", () => {
  it("matches the reference encoding for every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(encodeBase64(bytes)).toBe(reference(bytes));
  });

  it("matches the reference across chunk boundaries and trailing bytes", () => {
    for (const length of [0, 1, 2, 0x7fff, 0x8000, 0x8001, 0x12345]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 0xff);
      expect(encodeBase64(bytes)).toBe(reference(bytes));
    }
  });
});
