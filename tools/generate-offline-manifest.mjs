import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

async function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collectFiles(dir, baseDir = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, baseDir)));
    } else if (entry.isFile()) {
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      files.push({ fullPath, relPath });
    }
  }

  return files;
}

export async function generateOfflineManifest({ distRoot, buildId }) {
  if (!distRoot || !/^[a-f0-9]{16,64}$/i.test(buildId ?? "")) {
    throw new Error("generateOfflineManifest requires a dist directory and a valid release build ID.");
  }
  const absoluteDistRoot = path.resolve(distRoot);
  const releaseRoot = path.join(absoluteDistRoot, "releases", buildId);
  await stat(path.join(absoluteDistRoot, "index.html"));
  await stat(releaseRoot);

  const shellFiles = await collectFiles(absoluteDistRoot)
    .then((files) => files.filter((file) => file.relPath === "index.html"));
  const releaseFiles = await collectFiles(releaseRoot).then((files) => files.map((file) => ({
    ...file,
    relPath: path.posix.join("releases", buildId, file.relPath),
  })));
  const collected = [...shellFiles, ...releaseFiles]
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  const files = [];
  let totalBytes = 0;
  for (const item of collected) {
    const bytes = await readFile(item.fullPath);
    const digest = await sha256(bytes);
    files.push({ path: item.relPath, sizeBytes: bytes.byteLength, sha256: digest });
    totalBytes += bytes.byteLength;
  }

  let engineVersion = "unknown";
  try {
    const coreManifestPath = path.join(releaseRoot, "python-core", "source_manifest.json");
    const coreManifest = JSON.parse(await readFile(coreManifestPath, "utf8"));
    if (typeof coreManifest.engineVersion === "string") {
      engineVersion = coreManifest.engineVersion;
    }
  } catch {
    // Keep the manifest usable when optional Python assets are absent in a focused build.
  }

  let runtimeVersion = "unknown";
  try {
    const pinsPath = path.join(webRoot, "tools", "pyodide-runtime-manifest.json");
    const pins = JSON.parse(await readFile(pinsPath, "utf8"));
    if (typeof pins.runtime?.version === "string") {
      runtimeVersion = pins.runtime.version;
    }
  } catch {
    // Metadata is informational; each packaged asset is still checksum verified.
  }

  const manifest = {
    schemaVersion: 2,
    buildId,
    engineVersion,
    runtimeVersion,
    generatedAt: new Date().toISOString(),
    totalBytes,
    files,
  };
  await writeFile(path.join(absoluteDistRoot, "offline-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `Generated dist/offline-manifest.json for release ${buildId}: ${files.length} files, ` +
    `${(totalBytes / (1024 * 1024)).toFixed(2)} MiB.`,
  );
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(webRoot, "apps/client/dist");
  const buildId = process.argv[3];
  generateOfflineManifest({ distRoot, buildId }).catch((error) => {
    console.error("Failed to generate offline manifest:", error);
    process.exitCode = 1;
  });
}
