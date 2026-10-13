import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const publicRoot = path.join(webRoot, "apps", "client", "public");
const pyodideRoot = path.join(publicRoot, "pyodide");
const cacheRoot = path.join(webRoot, "node_modules", ".cache", "pyodide-runtime-assets");
const manifestPath = path.join(webRoot, "tools", "pyodide-runtime-manifest.json");
const pins = JSON.parse(await readFile(manifestPath, "utf8"));
const packageRoot = path.join(webRoot, "node_modules", "pyodide");
const packageInfo = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(path.join(packageRoot, "pyodide-lock.json"), "utf8"));

if (packageInfo.version !== pins.runtime.version) {
  throw new Error(`Expected pyodide ${pins.runtime.version}, found ${packageInfo.version}`);
}
if (packageLock.info.python !== pins.runtime.pythonVersion ||
    packageLock.info.abi_version !== pins.runtime.abiVersion ||
    packageLock.info.platform !== pins.runtime.platform) {
  throw new Error("Installed Pyodide catalog does not match the pinned Python/ABI/platform manifest");
}

const runtimeFiles = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

await mkdir(pyodideRoot, { recursive: true });
await mkdir(path.join(pyodideRoot, "wheels"), { recursive: true });
await mkdir(cacheRoot, { recursive: true });

const stagedFiles = [];
for (const fileName of runtimeFiles) {
  const source = path.join(packageRoot, fileName);
  const destination = path.join(pyodideRoot, fileName);
  await copyFile(source, destination);
  const bytes = await readFile(destination);
  stagedFiles.push({ path: `pyodide/${fileName}`, sizeBytes: bytes.byteLength, sha256: sha256(bytes), source: "npm pyodide@314.0.7" });
}

for (const pkg of pins.catalogPackages) {
  const entry = packageLock.packages[pkg.name];
  if (!entry || entry.version !== pkg.version || entry.file_name !== pkg.file || entry.sha256 !== pkg.sha256) {
    throw new Error(`Pyodide catalog pin mismatch for ${pkg.name}; refusing to fetch a different build`);
  }
  const url = `https://cdn.jsdelivr.net/pyodide/v${pins.runtime.version}/full/${pkg.file}`;
  const bytes = await fetchPinnedAsset(url, pkg.file, pkg.sha256);
  await writeFile(path.join(pyodideRoot, pkg.file), bytes);
  stagedFiles.push({ path: `pyodide/${pkg.file}`, sizeBytes: bytes.byteLength, sha256: pkg.sha256, source: url });
}

for (const wheel of pins.purePythonWheels) {
  const bytes = await fetchPinnedAsset(wheel.url, wheel.file, wheel.sha256);
  await writeFile(path.join(pyodideRoot, "wheels", wheel.file), bytes);
  stagedFiles.push({ path: `pyodide/wheels/${wheel.file}`, sizeBytes: bytes.byteLength, sha256: wheel.sha256, source: wheel.url });
}

const pyodideAssetManifest = {
  schemaVersion: 1,
  runtime: pins.runtime,
  stagedAtBuild: true,
  totalBytes: stagedFiles.reduce((total, file) => total + file.sizeBytes, 0),
  files: stagedFiles,
  purePythonWheels: pins.purePythonWheels.map(({ name, version, file, sha256, license, bundledAssets }) => ({
    name,
    version,
    file,
    sha256,
    license,
    ...(bundledAssets ? { bundledAssets } : {}),
  })),
};
await writeFile(path.join(pyodideRoot, "asset-manifest.json"), `${JSON.stringify(pyodideAssetManifest, null, 2)}\n`);

await stageFixtures();
await runCorePackager();

console.log(
  `Prepared self-hosted Pyodide ${pins.runtime.version}: ${stagedFiles.length} runtime/wheel files, ` +
  `${formatMiB(pyodideAssetManifest.totalBytes)} MiB; all pinned hashes verified.`,
);

async function fetchPinnedAsset(url, fileName, expectedHash) {
  const cached = path.join(cacheRoot, fileName);
  try {
    const cachedBytes = await readFile(cached);
    if (sha256(cachedBytes) === expectedHash) return cachedBytes;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch pinned asset ${fileName}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = sha256(bytes);
  if (actualHash !== expectedHash) {
    throw new Error(`SHA-256 mismatch for ${fileName}: expected ${expectedHash}, received ${actualHash}`);
  }
  await writeFile(cached, bytes);
  return bytes;
}

async function stageFixtures() {
  const fixtureRoot = path.join(webRoot, "tests", "fixtures");
  const fixtureManifestPath = path.join(fixtureRoot, "manifest.json");
  const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, "utf8"));
  const destinationRoot = path.join(publicRoot, "m1-fixtures");
  await mkdir(destinationRoot, { recursive: true });
  await mkdir(path.join(destinationRoot, "midi"), { recursive: true });

  for (const [fixtureId, fixture] of Object.entries(fixtureManifest.fixtureSources ?? {})) {
    if (typeof fixture.fixturePath !== "string" || !fixture.fixturePath.startsWith("midi/")) {
      throw new Error(`Fixture ${fixtureId} has an unsupported path`);
    }
    const relativeParts = fixture.fixturePath.split(/[\\/]/);
    if (relativeParts.some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Fixture ${fixtureId} has an unsafe path`);
    }
    const source = path.join(fixtureRoot, ...relativeParts);
    const destination = path.join(destinationRoot, ...relativeParts);
    const bytes = await readFile(source);
    if (sha256(bytes) !== fixture.fixtureSha256) {
      throw new Error(`Fixture checksum mismatch: ${fixtureId}`);
    }
    await copyFile(source, destination);
  }
  await writeFile(path.join(destinationRoot, "manifest.json"), `${JSON.stringify(fixtureManifest, null, 2)}\n`);
}

async function runCorePackager() {
  const corePackager = path.join(webRoot, "tools", "package-python-core.mjs");
  try {
    await access(corePackager);
  } catch {
    throw new Error("Missing tools/package-python-core.mjs; M1 analysis cannot run without packaged Python source");
  }
  const result = spawnSync(process.execPath, [corePackager], { cwd: webRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Python-core packager exited with status ${result.status}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}
