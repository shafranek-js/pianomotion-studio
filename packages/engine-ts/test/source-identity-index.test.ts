import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { M1AnalyzeMidiRequestSchema, validateM1AnalyzeMidiResultForRequest } from "@handthesia/contracts";
import { analyzeMidi, _engine_version } from "../src/index.ts";

const fixturesDir = resolve(__dirname, "../../../tests/fixtures");
const midiBytes = new Uint8Array(readFileSync(resolve(fixturesDir, "midi", "synthetic-duplicate-identities.mid")));
const options = {
  fixtureId: "synthetic-duplicate-identities",
  projectId: "source-identity-index",
  revision: 0,
  requestId: "source-identity-index-request",
  engineVersion: _engine_version(),
  sampleDense: true,
};

describe("ENG-12 source-identity index", () => {
  it("keeps merged identity mappings linked to every source note id", () => {
    const request = M1AnalyzeMidiRequestSchema.parse({
      type: "analyze-midi",
      requestId: options.requestId,
      projectId: options.projectId,
      revision: options.revision,
      engineVersion: options.engineVersion,
      midiBytes: midiBytes.buffer.slice(midiBytes.byteOffset, midiBytes.byteOffset + midiBytes.byteLength),
      options: { fixtureId: options.fixtureId, sampleDense: true },
    });
    const validated = validateM1AnalyzeMidiResultForRequest(request, {
      ...analyzeMidi(midiBytes, options),
      type: "analysis-result",
    });

    expect(validated.rawBaseline.identityMappings).toHaveLength(validated.rawBaseline.sourceNotes.length);
    const merged = validated.rawBaseline.identityMappings.filter((mapping) => mapping.status === "merged");
    expect(merged.length).toBeGreaterThan(0);

    const notesById = new Map(validated.document!.notes.map((note) => [note.noteId, note]));
    for (const mapping of merged) {
      expect(mapping.normalizedNoteId).not.toBeNull();
      const note = notesById.get(mapping.normalizedNoteId!);
      expect(note).toBeDefined();
      expect(note!.sourceNoteIds ?? []).toContain(mapping.noteId);
      expect(note!.sourceNoteIds!.length).toBeGreaterThan(1);
    }
  });
});
