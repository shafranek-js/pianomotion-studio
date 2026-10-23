import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { assertReleaseAssets } from "../../tools/release-assets.mjs";
import { makeValidStagedTree } from "./release-assets-fixture";

// The prepared-tree check hashes the real 60+ MiB runtime/SoundFont assets.
vi.setConfig({ testTimeout: 30_000 });

const publicRoot = fileURLToPath(new URL("../../apps/client/public/", import.meta.url));

async function emptyManifestRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pianomotion-release-assets-"));
  for (const dir of ["pyodide", "python-core", "builtin-melodies", "m1-fixtures", "soundfonts/musescore-general"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(path.join(root, "pyodide/asset-manifest.json"), JSON.stringify({
    runtime: { package: "pyodide", version: "test" },
    files: [],
  }));
  await writeFile(path.join(root, "python-core/source_manifest.json"), JSON.stringify({
    engineVersion: "a".repeat(64),
    files: {},
  }));
  await writeFile(path.join(root, "builtin-melodies/manifest.json"), JSON.stringify({ entries: [] }));
  await writeFile(path.join(root, "m1-fixtures/manifest.json"), JSON.stringify({ fixtureSources: {} }));
  await writeFile(path.join(root, "soundfonts/musescore-general/manifest.json"), JSON.stringify({
    assetPath: "empty.sf3",
    sha256: "b".repeat(64),
    byteLength: 0,
  }));
  await writeFile(path.join(root, "soundfonts/musescore-general/empty.sf3"), "");
  return root;
}

describe("DEP-6 standalone release asset validation", () => {
  it("accepts the prepared public tree", async () => {
    await expect(assertReleaseAssets(publicRoot)).resolves.toBeUndefined();
  });

  it("fails before build with an actionable message when runtime assets are absent", async () => {
    const emptyRoot = await mkdtemp(path.join(tmpdir(), "pianomotion-release-assets-"));
    try {
      await expect(assertReleaseAssets(emptyRoot)).rejects.toThrow(/prepare:m1:assets/);
      await expect(assertReleaseAssets(emptyRoot)).rejects.toThrow(/pyodide\/asset-manifest\.json/);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("rejects empty manifests and a zero-length soundfont", async () => {
    const root = await emptyManifestRoot();
    try {
      await expect(assertReleaseAssets(root)).rejects.toThrow(/has no files/);
      await expect(assertReleaseAssets(root)).rejects.toThrow(/files map is empty/);
      await expect(assertReleaseAssets(root)).rejects.toThrow(/no entries/);
      await expect(assertReleaseAssets(root)).rejects.toThrow(/no fixtureSources/);
      await expect(assertReleaseAssets(root)).rejects.toThrow(/invalid asset descriptor|empty file/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a directory where a core source file is expected", async () => {
    const root = await emptyManifestRoot();
    try {
      await mkdir(path.join(root, "python-core/handthesia_core/api.py"), { recursive: true });
      await writeFile(path.join(root, "python-core/source_manifest.json"), JSON.stringify({
        engineVersion: "a".repeat(64),
        files: { "handthesia_core/api.py": "c".repeat(64) },
      }));
      await expect(assertReleaseAssets(root)).rejects.toThrow(/not a regular file: python-core/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unpinned runtime version, empty wheels and a reduced core inventory", async () => {
    const tree = await makeValidStagedTree();
    try {
      await expect(assertReleaseAssets(tree.root)).resolves.toBeUndefined();

      const pyodide = JSON.parse(await readFile(path.join(tree.root, "pyodide/asset-manifest.json"), "utf8"));
      pyodide.runtime.version = "0.0.0-not-the-pin";
      pyodide.purePythonWheels = [];
      await tree.writeManifest("pyodide/asset-manifest.json", pyodide);
      await expect(assertReleaseAssets(tree.root)).rejects.toThrow(/pinned version|purePythonWheels/);

      const core = JSON.parse(await readFile(path.join(tree.root, "python-core/source_manifest.json"), "utf8"));
      core.files = Object.fromEntries(Object.entries(core.files).slice(0, 7));
      await tree.writeManifest("python-core/source_manifest.json", core);
      await expect(assertReleaseAssets(tree.root)).rejects.toThrow(/missing handthesia_core\/(hands|pianist|figures)\.py/);
    } finally {
      await rm(tree.root, { recursive: true, force: true });
    }
  });

  it("rejects a runtime record without size/hash and a corrupted file", async () => {
    const tree = await makeValidStagedTree();
    try {
      const pyodide = JSON.parse(await readFile(path.join(tree.root, "pyodide/asset-manifest.json"), "utf8"));
      pyodide.files = pyodide.files.map((file: { path: string }) =>
        file.path === "pyodide/pyodide.mjs" ? { path: file.path } : file
      );
      await tree.writeManifest("pyodide/asset-manifest.json", pyodide);
      await writeFile(path.join(tree.root, "pyodide/pyodide.mjs"), "corrupted");

      await expect(assertReleaseAssets(tree.root)).rejects.toThrow(/invalid sizeBytes|invalid sha256/);
    } finally {
      await rm(tree.root, { recursive: true, force: true });
    }
  });
});
