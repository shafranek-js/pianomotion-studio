import { describe, expect, it } from "vitest";
import { analyze_midi } from "@handthesia/engine-ts";
import { calculateDifficulty } from "../editor/difficulty.ts";
import { analyzeLibrarySource } from "./libraryAnalysisWorker.ts";

function oneNoteMidi(): Uint8Array {
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01,
    0x00, 0x60, 0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x13, 0x00, 0xff,
    0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0x90, 0x3c, 0x64, 0x60, 0x80, 0x3c,
    0x00, 0x00, 0xff, 0x2f, 0x00,
  ]);
}

describe("library analysis worker", () => {
  it("imports canonical MIDI and uses the built-in melody difficulty pipeline", async () => {
    const result = await analyzeLibrarySource("Local Study.mid", oneNoteMidi());
    const digest = (await import("@handthesia/engine-ts")).sha256(result.midiBytes);
    const expectedAnalysis = analyze_midi(result.midiBytes, {
      fixtureId: `builtin-${digest}`,
      projectId: "builtin-catalog",
      revision: 0,
      requestId: `builtin-catalog/${digest}`,
      engineVersion: "builtin-catalog",
      keyStyle: "realistic",
      keyboardRect: [0, 0, 1400, 150],
    });
    const expectedDifficulty = calculateDifficulty(
      expectedAnalysis.document,
      expectedAnalysis.fingeringPlan,
    );

    expect(Array.from(result.midiBytes.slice(0, 4))).toEqual([
      0x4d, 0x54, 0x68, 0x64,
    ]);
    expect(result.title).toBe("Local Study");
    expect(result.sourceFormat).toBe("midi");
    expect(result.durationSeconds).toBe(expectedAnalysis.document.durationSeconds);
    expect(result.durationSeconds).toBeCloseTo(0.5, 2);
    expect(result.noteCount).toBe(expectedAnalysis.document.notes.length);
    expect(result.noteCount).toBe(1);
    expect(result.difficultyScore).toBe(expectedDifficulty.overallScore);
    expect(result.difficultyTier).toBe(expectedDifficulty.tier);
    expect(result.previewNotes).toEqual([
      {
        noteId: expectedAnalysis.document.notes[0]!.noteId,
        pitch: 60,
        velocity: 100,
        startSeconds: 0,
        endSeconds: 0.5,
      },
    ]);
  });

  it("reports unsupported input and invalid MIDI as analysis errors", async () => {
    await expect(
      analyzeLibrarySource("score.txt", new Uint8Array([1, 2, 3])),
    ).rejects.toThrow(/Unsupported score format/i);
    await expect(
      analyzeLibrarySource("broken.mid", new Uint8Array([1, 2, 3])),
    ).rejects.toThrow();
  });

  it("rejects empty and oversized source data before conversion", async () => {
    await expect(analyzeLibrarySource("empty.mid", new Uint8Array())).rejects.toThrow(
      /empty/i,
    );
    await expect(
      analyzeLibrarySource("large.mid", new Uint8Array(16 * 1024 * 1024 + 1)),
    ).rejects.toThrow(/16 MiB/);
  });
});
