import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error - release tools are plain ESM scripts without declarations.
import { verifyReleaseDist } from "../../tools/verify-release-dist.mjs";
import { makeValidReleaseDist } from "./release-dist-fixture";

const roots: string[] = [];
const buildId = "a".repeat(24);

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pianomotion-verify-dist-"));
  roots.push(root);
  return root;
}

async function writeBase(root: string, manifest: unknown): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "offline-manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "index.html"), `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">releases/${buildId}/`);
  await writeFile(path.join(root, "sw.js"), `const BUILD_ID = "${buildId}";`);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("DEP-1 release dist verifier", () => {
  it("rejects an empty manifest instead of reporting a verified release", async () => {
    const root = await makeRoot();
    await writeBase(root, { schemaVersion: 2, buildId, totalBytes: 0, files: [] });

    await expect(verifyReleaseDist(root)).rejects.toThrow(/non-empty files array/);
  });

  it("rejects an index-only manifest without release entries or directory", async () => {
    const root = await makeRoot();
    await writeBase(root, {
      schemaVersion: 2,
      buildId,
      totalBytes: 1,
      files: [{ path: "index.html", sizeBytes: 1, sha256: "b".repeat(64) }],
    });

    await expect(verifyReleaseDist(root)).rejects.toThrow(/release directory|release entries|required release/);
  });

  it("rejects duplicate and foreign-build paths", async () => {
    const root = await makeRoot();
    await writeBase(root, {
      schemaVersion: 2,
      buildId,
      totalBytes: 2,
      files: [
        { path: "index.html", sizeBytes: 1, sha256: "b".repeat(64) },
        { path: "index.html", sizeBytes: 1, sha256: "b".repeat(64) },
        { path: `releases/${"c".repeat(24)}/assets/x.js`, sizeBytes: 1, sha256: "b".repeat(64) },
      ],
    });

    await expect(verifyReleaseDist(root)).rejects.toThrow(/duplicate manifest path|outside index\.html/);
  });

  it("rejects a file removed from disk and the offline inventory but still listed by the packaged manifest", async () => {
    const dist = await makeValidReleaseDist();
    roots.push(dist.root);
    await expect(verifyReleaseDist(dist.root)).resolves.toBeDefined();

    await dist.removeFromManifest(`releases/${buildId}/python-core/handthesia_core/hands.py`);
    await expect(verifyReleaseDist(dist.root)).rejects.toThrow(/absent from the offline manifest: handthesia_core\/hands\.py/);

    await dist.removeFromManifest(`releases/${buildId}/pyodide/pyodide.mjs`);
    await expect(verifyReleaseDist(dist.root)).rejects.toThrow(/absent from the offline manifest: pyodide\/pyodide\.mjs/);
  });
});
