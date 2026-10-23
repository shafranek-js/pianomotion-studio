import { describe, expect, it } from "vitest";
import { read_markers } from "../src/midiLoader.ts";

describe("ENG-13 fingering marker diagnostics", () => {
  it("reports the parse error instead of silently returning empty markers", () => {
    const diagnostics: Array<{ phase: string; type: string; message: string }> = [];
    const markers = read_markers(new Uint8Array([0x00, 0x01, 0x02]), diagnostics);

    expect(markers.size).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ phase: "fingering markers" });
    expect(diagnostics[0]!.message.length).toBeGreaterThan(0);
  });
});
