#!/usr/bin/env node
/**
 * Stage the generated test assets only when they are missing or stale.
 *
 * Playwright's `webServer` used to run `npm run dev`, so every one of the six
 * groups re-ran `predev`: a 21 MiB Pyodide staging, the melody catalogue and a
 * 38 MiB SoundFont copy, 20-40 s per server start and a real timeout risk on a
 * cold CI runner. This check makes a warm cache start the dev server in about a
 * second, and still repairs a fresh checkout or a changed Python core.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "apps", "client", "public");

function readJson(...parts) {
  try {
    return JSON.parse(readFileSync(path.join(...parts), "utf8"));
  } catch {
    return null;
  }
}

function soundfontPresent() {
  try {
    const files = readdirSync(path.join(publicRoot, "soundfonts", "musescore-general"));
    return files.some((name) => name.endsWith(".sf3"));
  } catch {
    return false;
  }
}

const sourceManifest = readJson(root, "python-core", "handthesia_core", "source_manifest.json");
const packagedManifest = readJson(publicRoot, "python-core", "source_manifest.json");
const packagedCoreFresh =
  sourceManifest !== null &&
  packagedManifest !== null &&
  sourceManifest.engineVersion === packagedManifest.engineVersion;

const steps = [
  {
    name: "Pyodide runtime and fixtures",
    ready:
      existsSync(path.join(publicRoot, "pyodide", "asset-manifest.json")) &&
      existsSync(path.join(publicRoot, "m1-fixtures", "manifest.json")) &&
      packagedCoreFresh,
    script: "tools/prepare-pyodide-runtime.mjs",
  },
  {
    name: "built-in melodies",
    ready: existsSync(path.join(publicRoot, "builtin-melodies", "manifest.json")),
    script: "tools/prepare-builtin-melodies.mjs",
  },
  {
    name: "SoundFont",
    ready: soundfontPresent(),
    script: "tools/prepare-builtin-soundfont.mjs",
  },
];

let staged = 0;
for (const step of steps) {
  if (step.ready) {
    continue;
  }
  staged += 1;
  console.log(`[ensure-test-assets] staging ${step.name}…`);
  const result = spawnSync(process.execPath, [path.join(root, step.script)], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
console.log(staged === 0 ? "[ensure-test-assets] assets already staged" : `[ensure-test-assets] staged ${staged} asset group(s)`);
