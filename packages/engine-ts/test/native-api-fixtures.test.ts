import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  M1AnalyzeMidiRequestSchema,
  validateM1AnalyzeMidiResultForRequest,
} from "@handthesia/contracts";
import { compareM1ResultToGolden, type GoldenFixture } from "../../../tests/parity/compare.ts";
import { analyze_midi, _engine_version } from "../src/index.ts";

const midiDir = resolve(__dirname, "../../../tests/fixtures/midi");
const goldenDir = resolve(__dirname, "../../../tests/fixtures/golden");
const builtinMidiDir = resolve(__dirname, "../../../builtin_melodies/midi");

function readMidi(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function analyzeFile(path: string, fixtureId: string) {
  const midiBytes = readMidi(path);
  const request = M1AnalyzeMidiRequestSchema.parse({
    type: "analyze-midi",
    requestId: `native-api/${fixtureId}`,
    projectId: "native-api-fixtures",
    revision: 0,
    engineVersion: _engine_version(),
    midiBytes: toArrayBuffer(midiBytes),
    options: { fixtureId, keyStyle: "realistic", sampleDense: false },
  });
  const result = analyze_midi(midiBytes, {
    ...request.options,
    fixtureId,
    projectId: request.projectId,
    revision: request.revision,
    requestId: request.requestId,
    engineVersion: request.engineVersion,
  });
  return { request, raw: result };
}

describe("TypeScript native API against real MIDI inputs", () => {
  it("returns request-valid results for every checked-in fixture and Chopsticks", () => {
    const fixtureFiles = readdirSync(midiDir)
      .filter((name) => name.endsWith(".mid"))
      .sort();
    expect(fixtureFiles).toHaveLength(13);

    const fixtureInputs = [
      ...fixtureFiles.map((name) => ({
        path: resolve(midiDir, name),
        fixtureId: name.slice(0, -4),
      })),
      { path: resolve(builtinMidiDir, "Chopsticks.mid"), fixtureId: "builtin-chopsticks" },
    ];
    const stressInput = fixtureInputs.find((input) => input.fixtureId === "synthetic-stress-512")!;
    const inputs = [stressInput, ...fixtureInputs.filter((input) => input !== stressInput)];

    const failures: string[] = [];
    const outcomes: string[] = [];
    const paritySamples = new Map<string, string[]>();
    let firstStressResult: unknown;
    for (const input of inputs) {
      let raw: Record<string, any> | undefined;
      try {
        const analyzed = analyzeFile(input.path, input.fixtureId);
        raw = analyzed.raw as Record<string, any>;
        if (input.fixtureId === "synthetic-stress-512") firstStressResult = analyzed.raw;
        const result = validateM1AnalyzeMidiResultForRequest(analyzed.request, {
          ...analyzed.raw,
          type: "analysis-result",
        });
        const expectedStatus = input.fixtureId === "synthetic-invalid-empty" ||
          input.fixtureId === "synthetic-invalid-non-midi"
          ? "invalid"
          : input.fixtureId === "synthetic-invalid-truncated" ? "repaired" : "loaded";
        expect(result.status, input.fixtureId).toBe(expectedStatus);
        if (expectedStatus === "loaded") {
          expect(result.document?.notes.length, input.fixtureId).toBeGreaterThan(0);
          expect(result.rawBaseline.identityMappings.length, input.fixtureId)
            .toBe(result.rawBaseline.sourceNotes.length);
        }
        if (expectedStatus === "repaired") {
          expect(result.rawBaseline.cleanup.join(" "), input.fixtureId).toContain("repaired the file after:");
        }

        if (fixtureFiles.includes(`${input.fixtureId}.mid`)) {
          const golden = JSON.parse(readFileSync(resolve(goldenDir, `${input.fixtureId}.json`), "utf-8")) as GoldenFixture;
          const parity = compareM1ResultToGolden(result, golden);
          const byCategory = new Map<string, number>();
          for (const difference of parity.differences) {
            byCategory.set(difference.category, (byCategory.get(difference.category) ?? 0) + 1);
            if (difference.category !== "raw-pose" && difference.category !== "physical-transform") {
              const samples = paritySamples.get(input.fixtureId) ?? [];
              if (samples.length < 6) {
                samples.push(`${difference.category} ${difference.path}: ${JSON.stringify(difference.expected)} != ${JSON.stringify(difference.actual)}`);
                paritySamples.set(input.fixtureId, samples);
              }
            }
          }
          expect(byCategory.get("notes") ?? 0, `${input.fixtureId} note/source assignment parity`).toBe(0);
          expect(byCategory.get("fingering") ?? 0, `${input.fixtureId} fingering assignment parity`).toBe(0);
          outcomes.push(`${input.fixtureId}: counts=${JSON.stringify(parity.actualCounts)}, parity=${JSON.stringify(Object.fromEntries(byCategory))}, samples=${JSON.stringify(paritySamples.get(input.fixtureId) ?? [])}`);
        } else {
          outcomes.push(`${input.fixtureId}: ${result.status}, notes=${result.document?.notes.length ?? 0}`);
        }
      } catch (error) {
        const issues = error && typeof error === "object" && "issues" in error
          ? (error.issues as Array<{ path: unknown[]; message: string }>).slice(0, 8).map((issue) =>
            `${issue.path.join(".")}: ${issue.message}`).join("; ") +
            ((error.issues as unknown[]).length > 8 ? `; ... ${((error.issues as unknown[]).length - 8)} more` : "")
          : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        let detail = "";
        if (raw) {
          const assignments = new Map((raw.fingeringPlan?.assignments ?? []).map((a: any) => [a.noteId, a]));
          const performanceIds = new Set((raw.performancePlan?.events ?? [])
            .filter((e: any) => e.type !== "pedal").map((e: any) => e.noteId));
          const mismatchIds = [...assignments.values()]
            .filter((a: any) => (a.disposition === "unplayable") === performanceIds.has(a.noteId))
            .slice(0, 4).map((a: any) => ({ assignment: a, performed: performanceIds.has(a.noteId) }));
          const pedals = (raw.performancePlan?.events ?? []).filter((e: any) => e.type === "pedal");
          const gliss = (raw.fingeringPlan?.assignments ?? [])
            .filter((a: any) => a.glissMode === "manual" || a.disposition === "glissando")
            .map((a: any) => ({ noteId: a.noteId, disposition: a.disposition, mode: a.glissMode }));
          detail = `; mismatches=${JSON.stringify(mismatchIds)}; pedals=${JSON.stringify(pedals)}; gliss=${JSON.stringify(gliss)}`;
        }
        failures.push(`${input.fixtureId}: ${issues}${detail}`);
      }
    }

    try {
      expect(firstStressResult, "stress fixture must have been analyzed first").toBeDefined();
      const stressAfterSequence = analyzeFile(stressInput.path, stressInput.fixtureId);
      expect(stressAfterSequence.raw, "stress API result after the other fixture sequence").toEqual(firstStressResult);
    } catch (error) {
      failures.push(`stress-512 after fixture sequence: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.info(outcomes.join("\n"));
    expect(failures).toEqual([]);
  }, 120_000);
});
