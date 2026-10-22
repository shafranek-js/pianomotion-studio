import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error - release tools are plain ESM scripts without declarations.
import { PINNED_CORE_MODULES, PINNED_PYODIDE_FILES, PINNED_PYODIDE_VERSION } from "../../tools/release-inventory.mjs";

const buildId = "a".repeat(24);
const prefix = `releases/${buildId}/`;

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function makeValidReleaseDist(): Promise<{ root: string; removeFromManifest(path: string): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "pianomotion-verify-dist-"));
  const files: Array<{ path: string; sizeBytes: number; sha256: string }> = [];

  const write = async (relativePath: string, content: string): Promise<void> => {
    const absolute = path.join(root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    files.push({ path: relativePath, sizeBytes: Buffer.byteLength(content), sha256: digest(content) });
  };

  const pyodideHashes = new Map<string, { sizeBytes: number; sha256: string }>();
  for (const relative of PINNED_PYODIDE_FILES) {
    const content = `pyodide:${relative}`;
    await write(`${prefix}${relative}`, content);
    pyodideHashes.set(relative, { sizeBytes: Buffer.byteLength(content), sha256: digest(content) });
  }
  await write(`${prefix}pyodide/asset-manifest.json`, JSON.stringify({
    runtime: { package: "pyodide", version: PINNED_PYODIDE_VERSION },
    files: Array.from(pyodideHashes, ([filePath, metadata]) => ({ path: filePath, ...metadata })),
  }));

  const coreHashes = new Map<string, string>();
  for (const relative of PINNED_CORE_MODULES) {
    const content = `core:${relative}`;
    await write(`${prefix}python-core/${relative}`, content);
    coreHashes.set(relative, digest(content));
  }
  await write(`${prefix}python-core/source_manifest.json`, JSON.stringify({
    engineVersion: "b".repeat(64),
    files: Object.fromEntries(coreHashes),
  }));

  await write(`${prefix}manifest.webmanifest`, "{}");
  await write(`${prefix}assets/app.js`, "console.log('app');");
  await write(`${prefix}soundfonts/musescore-general/test.sf3`, "sf3-bytes");
  await write("index.html", `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">${prefix}`);
  await writeFile(path.join(root, "sw.js"), `const BUILD_ID = "${buildId}";`);

  const manifest = {
    schemaVersion: 2,
    buildId,
    engineVersion: "b".repeat(64),
    runtimeVersion: PINNED_PYODIDE_VERSION,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files,
  };
  await writeFile(path.join(root, "offline-manifest.json"), JSON.stringify(manifest));

  return {
    root,
    async removeFromManifest(relativePath: string) {
      await rm(path.join(root, relativePath));
      const next = files.filter((file) => file.path !== relativePath);
      await writeFile(path.join(root, "offline-manifest.json"), JSON.stringify({
        ...manifest,
        totalBytes: next.reduce((sum, file) => sum + file.sizeBytes, 0),
        files: next,
      }));
    },
  };
}
