import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PINNED_CORE_MODULES,
  PINNED_PYODIDE_FILES,
  PINNED_PYODIDE_VERSION,
} from "./release-inventory.mjs";

const indexPath = "index.html";
const manifestPath = "offline-manifest.json";
const BUILD_ID = /^[0-9a-f]{24}$/;

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\\") || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

async function readText(filePath) {
  return readFile(filePath, "utf8");
}

/**
 * Verify the exact dist directory that is about to be uploaded. This does not
 * replace the local browser gate, but it rejects incomplete/corrupt artifacts
 * instead of trusting a manifest's own file list.
 */
export async function verifyReleaseDist(distRoot) {
  const root = path.resolve(distRoot);
  const manifest = JSON.parse(await readText(path.join(root, manifestPath)));
  const problems = [];

  if (manifest.schemaVersion !== 2) problems.push("offline-manifest.json schemaVersion must be 2");
  if (typeof manifest.buildId !== "string" || !BUILD_ID.test(manifest.buildId)) {
    problems.push("offline-manifest.json buildId must be 24 lowercase hex characters");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Release dist verification failed:\n- offline-manifest.json must contain a non-empty files array");
  }
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes <= 0) {
    problems.push("offline-manifest.json totalBytes must be a positive integer");
  }

  const buildId = manifest.buildId;
  const releasePrefix = `releases/${buildId}/`;
  const seen = new Set();
  const entriesByPath = new Map();
  let totalBytes = 0;
  let indexEntry = null;
  let releaseEntries = 0;
  const releasePaths = [];

  if (typeof manifest.engineVersion !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.engineVersion)) {
    problems.push("offline-manifest.json engineVersion must be 64 hex characters");
  }
  if (manifest.runtimeVersion !== PINNED_PYODIDE_VERSION) {
    problems.push(`offline-manifest.json runtimeVersion must be ${PINNED_PYODIDE_VERSION}`);
  }

  for (const file of manifest.files) {
    if (!file || !isSafeRelativePath(file.path)) {
      problems.push(`invalid or unsafe manifest path: ${JSON.stringify(file?.path)}`);
      continue;
    }
    if (seen.has(file.path)) {
      problems.push(`duplicate manifest path: ${file.path}`);
      continue;
    }
    seen.add(file.path);
    entriesByPath.set(file.path, file);
    if (file.path === indexPath) indexEntry = file;
    else if (file.path.startsWith(releasePrefix)) {
      releaseEntries += 1;
      releasePaths.push(file.path);
    } else {
      problems.push(`path outside index.html or ${releasePrefix}: ${file.path}`);
    }
    if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
      problems.push(`invalid sha256 for ${file.path}`);
      continue;
    }
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
      problems.push(`invalid sizeBytes for ${file.path}`);
      continue;
    }

    const absolute = path.resolve(root, file.path);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      problems.push(`path escapes dist: ${file.path}`);
      continue;
    }
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size !== file.sizeBytes) {
        problems.push(`size/file mismatch: ${file.path}`);
        continue;
      }
      if (await sha256(absolute) !== file.sha256) problems.push(`hash mismatch: ${file.path}`);
      totalBytes += file.sizeBytes;
    } catch {
      problems.push(`missing: ${file.path}`);
    }
  }

  if (!indexEntry) problems.push("manifest must include index.html");
  if (releaseEntries === 0) problems.push(`manifest must include ${releasePrefix} entries`);

  try {
    const releaseInfo = await stat(path.join(root, "releases", buildId));
    if (!releaseInfo.isDirectory()) problems.push(`releases/${buildId} is not a directory`);
  } catch {
    problems.push(`missing release directory: releases/${buildId}`);
  }

  const requiredReleaseEntries = [
    `${releasePrefix}manifest.webmanifest`,
    `${releasePrefix}pyodide/asset-manifest.json`,
    `${releasePrefix}pyodide/pyodide.asm.wasm`,
    `${releasePrefix}python-core/source_manifest.json`,
    `${releasePrefix}python-core/handthesia_core/api.py`,
  ];
  for (const required of requiredReleaseEntries) {
    if (!seen.has(required)) problems.push(`required release entry missing: ${required}`);
  }
  if (!releasePaths.some((entry) => entry.startsWith(`${releasePrefix}assets/`))) {
    problems.push(`required release assets missing under ${releasePrefix}assets/`);
  }
  if (!releasePaths.some((entry) => entry.startsWith(`${releasePrefix}soundfonts/`) && entry.endsWith(".sf3"))) {
    problems.push(`required soundfont missing under ${releasePrefix}soundfonts/`);
  }

  try {
    const runtimeManifest = JSON.parse(await readText(path.join(root, "releases", buildId, "pyodide", "asset-manifest.json")));
    if (runtimeManifest.runtime?.version !== manifest.runtimeVersion) {
      problems.push("packaged pyodide runtime version does not match the offline manifest");
    }
    const packagedFiles = Array.isArray(runtimeManifest.files) ? runtimeManifest.files : [];
    for (const required of PINNED_PYODIDE_FILES) {
      if (!packagedFiles.some((file) => file?.path === required)) problems.push(`packaged pyodide manifest is missing ${required}`);
    }
    for (const file of packagedFiles) {
      if (typeof file?.path !== "string") {
        problems.push("packaged pyodide manifest has an entry without a path");
        continue;
      }
      const offlinePath = `${releasePrefix}${file.path}`;
      const offlineEntry = entriesByPath.get(offlinePath);
      if (!offlineEntry) {
        problems.push(`packaged pyodide file is absent from the offline manifest: ${file.path}`);
        continue;
      }
      if (offlineEntry.sizeBytes !== file.sizeBytes || offlineEntry.sha256 !== file.sha256) {
        problems.push(`packaged/offline size or hash mismatch: ${file.path}`);
      }
    }
  } catch {
    problems.push("missing or invalid packaged pyodide/asset-manifest.json");
  }

  try {
    const coreManifest = JSON.parse(await readText(path.join(root, "releases", buildId, "python-core", "source_manifest.json")));
    if (coreManifest.engineVersion !== manifest.engineVersion) {
      problems.push("packaged python-core engineVersion does not match the offline manifest");
    }
    const coreFiles = coreManifest.files && typeof coreManifest.files === "object" && !Array.isArray(coreManifest.files)
      ? coreManifest.files
      : {};
    for (const required of PINNED_CORE_MODULES) {
      if (!(required in coreFiles)) problems.push(`packaged python-core manifest is missing ${required}`);
    }
    for (const [relativePath, expectedHash] of Object.entries(coreFiles)) {
      const offlinePath = `${releasePrefix}python-core/${relativePath}`;
      const offlineEntry = entriesByPath.get(offlinePath);
      if (!offlineEntry) {
        problems.push(`packaged python-core file is absent from the offline manifest: ${relativePath}`);
        continue;
      }
      if (offlineEntry.sha256 !== expectedHash) {
        problems.push(`packaged/offline core hash mismatch: ${relativePath}`);
      }
    }
  } catch {
    problems.push("missing or invalid packaged python-core/source_manifest.json");
  }

  if (manifest.totalBytes !== totalBytes) {
    problems.push(`totalBytes mismatch: manifest ${manifest.totalBytes}, verified ${totalBytes}`);
  }

  let index = "";
  try {
    index = await readText(path.join(root, indexPath));
  } catch {
    problems.push("missing index.html");
  }
  const cspMeta = index.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i);
  const cspContent = cspMeta?.[0].match(/content=(["'])(.*?)\1/i)?.[2];
  if (!cspContent || cspContent.trim().length === 0) {
    problems.push("index.html has no non-empty CSP meta tag");
  } else if (!/\bdefault-src\b/.test(cspContent) || !/\bscript-src\b/.test(cspContent)) {
    problems.push("index.html CSP is missing default-src/script-src");
  }
  if (!index.includes(releasePrefix)) {
    problems.push(`index.html does not reference ${releasePrefix}`);
  }

  let serviceWorker = "";
  try {
    serviceWorker = await readText(path.join(root, "sw.js"));
  } catch {
    problems.push("missing sw.js");
  }
  if (!serviceWorker.includes(`const BUILD_ID = "${buildId}";`)) {
    problems.push(`sw.js does not define BUILD_ID = "${buildId}"`);
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, 20).map((problem) => `- ${problem}`).join("\n");
    const more = problems.length > 20 ? `\n- … ${problems.length - 20} more` : "";
    throw new Error(`Release dist verification failed (${problems.length} problems):\n${shown}${more}`);
  }

  console.log(`Verified dist ${buildId}: ${manifest.files.length} files, ${totalBytes} bytes, shell/runtime/CSP/service-worker invariants present.`);
  return manifest;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const distRoot = process.argv[2] ?? path.resolve(fileURLToPath(new URL("../", import.meta.url)), "apps/client/dist");
  verifyReleaseDist(distRoot).catch((error) => {
    console.error("Release dist verification failed:", error);
    process.exitCode = 1;
  });
}
