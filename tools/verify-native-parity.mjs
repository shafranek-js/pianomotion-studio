import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { M1AnalyzeMidiRequestSchema, validateM1AnalyzeMidiResultForRequest } from "@handthesia/contracts";
import { analyze_midi, _engine_version } from "../packages/engine-ts/src/api.ts";
import { compareM1ResultToGolden } from "../tests/parity/compare.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = path.join(root, "tests", "fixtures");
const output = path.join(root, "test-results", "reports", "native-parity.json");
const hash = createHash("sha256");
for (const name of (await readdir(path.join(root, "packages", "engine-ts", "src"))).filter(name => name.endsWith(".ts")).sort()) {
  hash.update(name);
  hash.update("\0");
  hash.update((await readFile(path.join(root, "packages", "engine-ts", "src", name), "utf8")).replaceAll("\r\n", "\n"));
  hash.update("\0");
}
const report = {
  targetPythonEngineVersion: _engine_version(), nativeSourceSha256: hash.digest("hex"),
  generatedAt: new Date().toISOString(), fixtures: [],
};
for (const name of (await readdir(path.join(fixtures, "midi"))).filter(name => name.endsWith(".mid")).sort()) {
  const fixtureId = name.slice(0, -4);
  try {
    const bytes = new Uint8Array(await readFile(path.join(fixtures, "midi", name)));
    const request = M1AnalyzeMidiRequestSchema.parse({
      type: "analyze-midi", requestId: `native-parity/${fixtureId}`, projectId: "native-parity",
      revision: 0, engineVersion: _engine_version(), midiBytes: bytes.buffer,
      options: { fixtureId, keyStyle: "realistic", sampleDense: false },
    });
    const result = validateM1AnalyzeMidiResultForRequest(request, {
      ...analyze_midi(bytes, { ...request.options, projectId: request.projectId,
        revision: request.revision, requestId: request.requestId, engineVersion: request.engineVersion }),
      type: "analysis-result",
    });
    const golden = JSON.parse(await readFile(path.join(fixtures, "golden", `${fixtureId}.json`), "utf8"));
    const parity = compareM1ResultToGolden(result, golden);
    const categories = {};
    for (const difference of parity.differences) categories[difference.category] = (categories[difference.category] ?? 0) + 1;
    report.fixtures.push({ fixtureId, valid: true, categories, ...parity });
    console.log(`${fixtureId}: ${parity.differences.length === 0 ? "PARITY PASS" : JSON.stringify(categories)}`);
  } catch (error) {
    report.fixtures.push({ fixtureId, valid: false, error: error instanceof Error ? error.message : String(error) });
    console.log(`${fixtureId}: ERROR`);
  }
}
report.passed = report.fixtures.length === 13 && report.fixtures.every(fixture => fixture.valid && fixture.differences.length === 0);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Native numerical parity ${report.passed ? "PASS" : "OPEN"}. Report: ${output}`);
if (!report.passed) process.exitCode = 1;
