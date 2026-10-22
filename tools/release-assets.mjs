import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  PINNED_ABI_VERSION,
  PINNED_CORE_MODULES,
  PINNED_PLATFORM,
  PINNED_PYODIDE_FILES,
  PINNED_PYODIDE_VERSION,
  PINNED_PYTHON_VERSION,
  PINNED_PYTHON_WHEELS,
} from "./release-inventory.mjs";

const REQUIRED_PYODIDE_FILES = PINNED_PYODIDE_FILES;
const REQUIRED_CORE_FILES = PINNED_CORE_MODULES;

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function fileInfo(filePath) {
  const info = await stat(filePath);
  return { info, isFile: info.isFile(), size: info.size };
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function hex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

/**
 * Fail a standalone release build before Vite when the runtime assets that are
 * normally produced by `prepare:m1:assets` are absent or structurally invalid.
 * The check deliberately validates non-empty inventories, pinned runtime/core
 * files and declared size/hash values instead of trusting empty manifests.
 */
export async function assertReleaseAssets(publicRoot) {
  const root = path.resolve(publicRoot);
  const problems = [];

  const requireFile = async (relativePath, expected = {}) => {
    const absolute = path.resolve(root, relativePath);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      problems.push(`unsafe path: ${relativePath}`);
      return;
    }
    try {
      const { isFile, size } = await fileInfo(absolute);
      if (!isFile) {
        problems.push(`not a regular file: ${relativePath}`);
        return;
      }
      if (size <= 0 && !expected.allowEmpty) {
        problems.push(`empty file: ${relativePath}`);
        return;
      }
      if (Number.isSafeInteger(expected.sizeBytes) && size !== expected.sizeBytes) {
        problems.push(`size mismatch: ${relativePath}`);
      }
      if (expected.sha256 && await sha256(absolute) !== expected.sha256) {
        problems.push(`hash mismatch: ${relativePath}`);
      }
    } catch {
      problems.push(`missing: ${relativePath}`);
    }
  };

  const pyodideManifestPath = path.join(root, "pyodide", "asset-manifest.json");
  try {
    const manifest = await readJson(pyodideManifestPath);
    const runtime = manifest.runtime;
    if (!runtime || runtime.package !== "pyodide" ||
        runtime.version !== PINNED_PYODIDE_VERSION ||
        runtime.pythonVersion !== PINNED_PYTHON_VERSION ||
        runtime.abiVersion !== PINNED_ABI_VERSION ||
        runtime.platform !== PINNED_PLATFORM) {
      problems.push("pyodide runtime metadata does not match the pinned version/ABI/platform");
    }
    if (!Array.isArray(manifest.purePythonWheels)) {
      problems.push("pyodide/asset-manifest.json has no purePythonWheels");
    } else {
      const wheels = new Set(manifest.purePythonWheels.map((wheel) => wheel?.file));
      for (const required of PINNED_PYTHON_WHEELS) {
        if (!wheels.has(required)) problems.push(`pyodide purePythonWheels is missing ${required}`);
      }
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      problems.push("pyodide/asset-manifest.json has no files");
    } else {
      const entries = new Map(manifest.files.map((file) => [file?.path, file]));
      for (const required of REQUIRED_PYODIDE_FILES) {
        if (!entries.has(required)) problems.push(`pyodide manifest is missing ${required}`);
      }
      for (const file of manifest.files) {
        if (typeof file?.path !== "string") {
          problems.push("pyodide manifest contains an entry without a path");
          continue;
        }
        if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
          problems.push(`pyodide manifest has invalid sizeBytes for ${file.path}`);
          continue;
        }
        if (!hex64(file.sha256)) {
          problems.push(`pyodide manifest has invalid sha256 for ${file.path}`);
          continue;
        }
        await requireFile(file.path, { sizeBytes: file.sizeBytes, sha256: file.sha256 });
      }
    }
  } catch {
    problems.push("missing or invalid pyodide/asset-manifest.json");
  }

  const pythonManifestPath = path.join(root, "python-core", "source_manifest.json");
  try {
    const manifest = await readJson(pythonManifestPath);
    if (!hex64(manifest.engineVersion)) problems.push("python-core/source_manifest.json has no valid engineVersion");
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
      problems.push("python-core/source_manifest.json has no files map");
    } else {
      const files = manifest.files;
      if (Object.keys(files).length === 0) problems.push("python-core/source_manifest.json files map is empty");
      for (const required of REQUIRED_CORE_FILES) {
        if (!(required in files)) problems.push(`python-core manifest is missing ${required}`);
      }      for (const [relativePath, expectedHash] of Object.entries(files)) {
        if (!hex64(expectedHash)) problems.push(`python-core manifest has invalid hash for ${relativePath}`);
        await requireFile(path.join("python-core", relativePath), { sha256: expectedHash });
      }
    }
  } catch {
    problems.push("missing or invalid python-core/source_manifest.json");
  }

  const melodyManifestPath = path.join(root, "builtin-melodies", "manifest.json");
  try {
    const manifest = await readJson(melodyManifestPath);
    if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
      problems.push("builtin-melodies/manifest.json has no entries");
    } else {
      for (const entry of manifest.entries) {
        if (!entry?.assetPath || !hex64(entry.sha256) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength <= 0) {
          problems.push(`builtin melody has an invalid asset descriptor: ${JSON.stringify(entry?.id)}`);
          continue;
        }
        await requireFile(path.join("builtin-melodies", entry.assetPath), { sizeBytes: entry.byteLength, sha256: entry.sha256 });
      }
    }
  } catch {
    problems.push("missing or invalid builtin-melodies/manifest.json");
  }

  const fixtureManifestPath = path.join(root, "m1-fixtures", "manifest.json");
  try {
    const manifest = await readJson(fixtureManifestPath);
    const fixtures = Object.values(manifest.fixtureSources ?? {});
    if (fixtures.length === 0) problems.push("m1-fixtures/manifest.json has no fixtureSources");
    for (const fixture of fixtures) {
      if (!fixture?.fixturePath || !hex64(fixture.fixtureSha256)) {
        problems.push("fixture has an invalid path/hash descriptor");
        continue;
      }
      await requireFile(path.join("m1-fixtures", fixture.fixturePath), { sha256: fixture.fixtureSha256, allowEmpty: true });
    }
  } catch {
    problems.push("missing or invalid m1-fixtures/manifest.json");
  }

  const soundfontDir = path.join("soundfonts", "musescore-general");
  try {
    const manifest = await readJson(path.join(root, soundfontDir, "manifest.json"));
    if (!manifest.assetPath || !hex64(manifest.sha256) || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength <= 0) {
      problems.push("soundfont manifest has an invalid asset descriptor");
    } else {
      await requireFile(path.join(soundfontDir, manifest.assetPath), { sizeBytes: manifest.byteLength, sha256: manifest.sha256 });
      if (manifest.licenseDocument) await requireFile(path.join(soundfontDir, manifest.licenseDocument));
    }
  } catch {
    problems.push("missing or invalid soundfonts/musescore-general/manifest.json");
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, 20).map((entry) => `- ${entry}`).join("\n");
    const more = problems.length > 20 ? `\n- … ${problems.length - 20} more` : "";
    throw new Error(
      `Release assets are incomplete or invalid (${problems.length} problems). ` +
      `Run "npm run prepare:m1:assets" before "npm run build".\nProblems:\n${shown}${more}`,
    );
  }
}
