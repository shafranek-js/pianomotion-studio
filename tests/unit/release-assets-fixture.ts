import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error - release tools are plain ESM scripts without declarations.
import {
  PINNED_ABI_VERSION,
  PINNED_CORE_MODULES,
  PINNED_PLATFORM,
  PINNED_PYODIDE_FILES,
  PINNED_PYODIDE_VERSION,
  PINNED_PYTHON_VERSION,
  PINNED_PYTHON_WHEELS,
} from "../../tools/release-inventory.mjs";

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function makeValidStagedTree(): Promise<{ root: string; writeManifest(relativePath: string, value: unknown): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "pianomotion-release-assets-"));
  const write = async (relativePath: string, content: string) => {
    const absolute = path.join(root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    return { sizeBytes: Buffer.byteLength(content), sha256: digest(content) };
  };

  const pyodideFiles = [];
  for (const relative of PINNED_PYODIDE_FILES) {
    const content = `pyodide:${relative}`;
    await write(relative, content);
    pyodideFiles.push({ path: relative, sizeBytes: Buffer.byteLength(content), sha256: digest(content) });
  }
  await write("pyodide/asset-manifest.json", JSON.stringify({
    runtime: {
      package: "pyodide",
      version: PINNED_PYODIDE_VERSION,
      pythonVersion: PINNED_PYTHON_VERSION,
      abiVersion: PINNED_ABI_VERSION,
      platform: PINNED_PLATFORM,
    },
    files: pyodideFiles,
    purePythonWheels: PINNED_PYTHON_WHEELS.map((file) => ({ file })),
  }));

  const coreFiles: Record<string, string> = {};
  for (const relative of PINNED_CORE_MODULES) {
    const content = `core:${relative}`;
    await write(path.join("python-core", relative), content);
    coreFiles[relative] = digest(content);
  }
  await write("python-core/source_manifest.json", JSON.stringify({
    engineVersion: "c".repeat(64),
    files: coreFiles,
  }));

  const melodyBytes = "melody";
  await write("builtin-melodies/files/melody.mid", melodyBytes);
  await write("builtin-melodies/manifest.json", JSON.stringify({
    entries: [{ id: "melody", assetPath: "files/melody.mid", byteLength: Buffer.byteLength(melodyBytes), sha256: digest(melodyBytes) }],
  }));

  const fixtureBytes = "fixture";
  await write("m1-fixtures/midi/fixture.mid", fixtureBytes);
  await write("m1-fixtures/manifest.json", JSON.stringify({
    fixtureSources: { fixture: { fixturePath: "midi/fixture.mid", fixtureSha256: digest(fixtureBytes) } },
  }));

  const soundfontBytes = "sf3";
  await write("soundfonts/musescore-general/bank.sf3", soundfontBytes);
  await write("soundfonts/musescore-general/LICENSE.txt", "license");
  await write("soundfonts/musescore-general/manifest.json", JSON.stringify({
    assetPath: "bank.sf3",
    byteLength: Buffer.byteLength(soundfontBytes),
    sha256: digest(soundfontBytes),
    licenseDocument: "LICENSE.txt",
  }));

  return {
    root,
    async writeManifest(relativePath, value) {
      await writeFile(path.join(root, relativePath), JSON.stringify(value));
    },
  };
}
