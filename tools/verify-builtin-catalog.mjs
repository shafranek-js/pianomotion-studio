#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { M1AnalyzeMidiResultSchema } from "../packages/contracts/src/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogManifestPath = path.join(repoRoot, "apps", "client", "public", "builtin-melodies", "manifest.json");
const sourceManifestPath = path.join(repoRoot, "python-core", "handthesia_core", "source_manifest.json");
const packagedSourceManifestPath = path.join(repoRoot, "apps", "client", "public", "python-core", "source_manifest.json");
const reportPath = path.join(repoRoot, "test-results", "reports", "builtin-catalog.json");

const catalog = JSON.parse(await readFile(catalogManifestPath, "utf8"));
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
const packagedSourceManifest = JSON.parse(await readFile(packagedSourceManifestPath, "utf8"));
if (sourceManifest.engineVersion !== packagedSourceManifest.engineVersion) {
  throw new Error("Packaged public Python-core manifest is stale; refresh the M1 runtime freeze before verification");
}
const engineVersion = packagedSourceManifest.engineVersion;
if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) {
  throw new Error("Built-in melody manifest has no catalog entries");
}

const localPython = path.join(
  repoRoot,
  ".venv-test",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const pythonPath = process.env.PIANOMOTION_TEST_PYTHON || (existsSync(localPython) ? localPython : "python");
const pythonSource = String.raw`
import hashlib
import json
import os
import sys
from pathlib import Path, PureWindowsPath

sys.path.insert(0, "python-core")
from handthesia_core.api import analyze_midi

catalog = json.loads(Path("apps/client/public/builtin-melodies/manifest.json").read_text("utf-8"))
source_dir = Path("builtin_melodies/midi")
source_root = source_dir.resolve()

for entry in catalog["entries"]:
    metadata = {"id": entry.get("id"), "title": entry.get("title"), "fileName": entry.get("fileName")}
    try:
        file_name = entry["fileName"]
        relative_name = file_name.replace("\\", "/") if isinstance(file_name, str) else ""
        parts = relative_name.split("/")
        if (not relative_name or relative_name.startswith("/") or PureWindowsPath(file_name).drive or
                any(part in ("", ".", "..") for part in parts)):
            raise ValueError("catalog fileName must be a safe source-relative path")
        source_path = source_root.joinpath(*parts).resolve()
        if source_root not in source_path.parents:
            raise ValueError("catalog fileName escapes the canonical source directory")
        payload = source_path.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        if digest != entry.get("sha256"):
            raise ValueError(f"source MIDI checksum mismatch: manifest={entry.get('sha256')} source={digest}")
        if len(payload) != entry.get("byteLength"):
            raise ValueError(f"source MIDI byte length mismatch: manifest={entry.get('byteLength')} source={len(payload)}")
        result = analyze_midi(payload, {
            "fixtureId": "builtin-" + str(entry["id"]),
            "projectId": "builtin-catalog-validation",
            "revision": 0,
            "requestId": "builtin-catalog-validation/" + str(entry["id"]),
            "engineVersion": os.environ["PIANOMOTION_EXPECTED_ENGINE_VERSION"],
            "keyStyle": "realistic",
            "keyboardRect": [0, 0, 1400, 150],
        })
        print(json.dumps({
            **metadata,
            "sourceSha256": digest,
            "byteLength": len(payload),
            "result": result,
        }, separators=(",", ":"), allow_nan=False), flush=True)
    except Exception as exc:
        print(json.dumps({**metadata, "failure": f"{type(exc).__name__}: {str(exc)[:400]}"},
                         separators=(",", ":"), flush=True))
`;

const python = spawn(pythonPath, ["-u", "-c", pythonSource], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
    PIANOMOTION_EXPECTED_ENGINE_VERSION: engineVersion,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const pythonExit = new Promise((resolve) => {
  python.once("error", (error) => resolve(error));
  python.once("close", (code) => resolve(code));
});

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  validator: "M1AnalyzeMidiResultSchema",
  catalogManifest: "apps/client/public/builtin-melodies/manifest.json",
  sourceDirectory: "builtin_melodies/midi",
  engineVersion,
  catalogCount: catalog.entries.length,
  checkedCount: 0,
  schemaValidCount: 0,
  failureCount: 0,
  totals: {
    sourceNotes: 0,
    normalizedNotes: 0,
    motionPlanPoses: 0,
    initialMotionWindowPoses: 0,
    identityStatuses: {},
    resultDiagnostics: {},
  },
  files: [],
};

const lines = createInterface({ input: python.stdout, crlfDelay: Infinity });
for await (const line of lines) {
  let item;
  try {
    item = JSON.parse(line);
  } catch (error) {
    report.files.push({
      title: "<invalid Python stream line>",
      schemaValid: false,
      issues: [{ path: [], message: `Invalid JSON from Python: ${String(error).slice(0, 250)}` }],
    });
    report.failureCount += 1;
    report.checkedCount += 1;
    continue;
  }

  report.checkedCount += 1;
  const file = {
    id: item.id ?? null,
    title: item.title ?? null,
    fileName: item.fileName ?? null,
    fixtureId: item.id ? `builtin-${item.id}` : null,
    sourceSha256: item.sourceSha256 ?? null,
    byteLength: item.byteLength ?? null,
    status: null,
    sourceNotes: 0,
    normalizedNotes: 0,
    identityStatuses: {},
    diagnostics: { result: {}, fingeringPlan: {}, performancePlan: {}, motionPlan: {} },
    motionPlanPoses: 0,
    initialMotionWindowPoses: 0,
    schemaValid: false,
    issues: [],
  };

  if (item.failure) {
    file.issues.push({ path: [], message: item.failure });
  } else {
    const result = { type: "analysis-result", ...item.result };
    const checked = M1AnalyzeMidiResultSchema.safeParse(result);
    file.status = result.status;
    file.sourceNotes = result.rawBaseline?.sourceNotes?.length ?? 0;
    file.normalizedNotes = result.document?.notes?.length ?? 0;
    file.motionPlanPoses = result.motionPlan?.poses?.length ?? 0;
    file.initialMotionWindowPoses = result.initialMotionWindow?.poses?.length ?? 0;
    for (const mapping of result.rawBaseline?.identityMappings ?? []) {
      file.identityStatuses[mapping.status] = (file.identityStatuses[mapping.status] ?? 0) + 1;
    }
    for (const [key, diagnostics] of [
      ["result", result.diagnostics],
      ["fingeringPlan", result.fingeringPlan?.diagnostics],
      ["performancePlan", result.performancePlan?.diagnostics],
      ["motionPlan", result.motionPlan?.diagnostics],
    ]) {
      for (const diagnostic of diagnostics ?? []) {
        file.diagnostics[key][diagnostic.code] = (file.diagnostics[key][diagnostic.code] ?? 0) + 1;
      }
    }
    if (!checked.success) {
      file.issues = checked.error.issues.slice(0, 20).map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message.slice(0, 400),
      }));
    } else if (result.status === "invalid") {
      file.issues.push({ path: ["status"], message: "Built-in MIDI analysis returned invalid status" });
    } else if (result.engineVersion !== engineVersion ||
               result.rawBaseline.fixtureId !== file.fixtureId ||
               result.rawBaseline.inputSha256 !== item.sourceSha256 ||
               result.resource.byteLength !== item.byteLength) {
      file.issues.push({ path: [], message: "Analysis result engine version or source-byte identity does not match the validated input" });
    } else {
      file.schemaValid = true;
    }

    report.totals.sourceNotes += file.sourceNotes;
    report.totals.normalizedNotes += file.normalizedNotes;
    report.totals.motionPlanPoses += file.motionPlanPoses;
    report.totals.initialMotionWindowPoses += file.initialMotionWindowPoses;
    for (const [status, count] of Object.entries(file.identityStatuses)) {
      report.totals.identityStatuses[status] = (report.totals.identityStatuses[status] ?? 0) + count;
    }
    for (const [code, count] of Object.entries(file.diagnostics.result)) {
      report.totals.resultDiagnostics[code] = (report.totals.resultDiagnostics[code] ?? 0) + count;
    }
  }

  if (file.schemaValid) report.schemaValidCount += 1;
  else report.failureCount += 1;
  report.files.push(file);
  if (report.checkedCount % 20 === 0) process.stderr.write(`validated ${report.checkedCount}/${report.catalogCount} catalog results\n`);
}

const pythonExitCode = await pythonExit;
if (typeof pythonExitCode !== "number" || pythonExitCode !== 0) {
  report.failureCount += 1;
  report.files.push({
    title: "<Python process>",
    schemaValid: false,
    issues: [{ path: [], message: `Python process failed: ${String(pythonExitCode)}` }],
  });
}
if (report.checkedCount !== report.catalogCount) {
  report.failureCount += 1;
  report.files.push({
    title: "<catalog stream>",
    schemaValid: false,
    issues: [{ path: [], message: `Expected ${report.catalogCount} results, received ${report.checkedCount}` }],
  });
}

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(
  `Built-in catalog schema validation: ${report.schemaValidCount}/${report.catalogCount} valid; ` +
  `${report.failureCount} failures. Report: test-results/reports/builtin-catalog.json\n`,
);
if (report.failureCount > 0) process.exitCode = 1;
