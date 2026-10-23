/**
 * Cloudflare Workers Static Assets accepts files up to 25 MiB.
 * Preserve PianoMotion's exact release checksums by splitting oversized SF3
 * banks only AFTER the ordinary release build and verify:release have passed.
 * The Worker serves the unchanged original URL by streaming these parts.
 */
import { createHash } from "node:crypto";
import { open, readdir, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const DEFAULT_DIST = resolve(projectRoot, "apps/client/dist");
export const MAX_ASSET = 25 * 1024 * 1024;
export const CHUNK_BYTES = 16 * 1024 * 1024;
const HASHED_SF3 = /^releases\/[a-f0-9]{24}\/soundfonts\/musescore-general\/[a-f0-9]{64}\.sf3$/;

async function* walk(root, current = root) {
  for (const item of await readdir(current, { withFileTypes: true })) {
    const p = join(current, item.name);
    if (item.isDirectory()) yield* walk(root, p);
    else if (item.isFile()) yield { path: p, relativePath: relative(root, p).split(sep).join("/") };
  }
}

export async function splitCloudflareAssets(distRoot = DEFAULT_DIST) {
  const root = resolve(distRoot);
  const sourceManifest = JSON.parse(await readFile(join(root, "offline-manifest.json"), "utf8"));
  const originalManifestFiles = new Map(sourceManifest.files.map((entry) => [entry.path, entry]));
  const largeAssets = [];
  for await (const file of walk(root)) {
    const bytes = (await stat(file.path)).size;
    if (bytes > MAX_ASSET) {
      if (!HASHED_SF3.test(file.relativePath)) {
        throw new Error("Cloudflare 25 MiB asset limit exceeded by unsupported file: " + file.relativePath + " (" + bytes + " bytes)");
      }
      largeAssets.push({ ...file, bytes });
    }
  }

  for (const file of largeAssets) {
    const manifestEntry = originalManifestFiles.get(file.relativePath);
    if (!manifestEntry || manifestEntry.sizeBytes !== file.bytes) {
      throw new Error("Offline manifest does not match oversized file " + file.relativePath);
    }
    const source = await open(file.path, "r");
    const parts = [];
    const digest = createHash("sha256");
    try {
      let offset = 0;
      while (offset < file.bytes) {
        const count = Math.min(CHUNK_BYTES, file.bytes - offset);
        const buffer = Buffer.allocUnsafe(count);
        let used = 0;
        while (used < count) {
          const result = await source.read(buffer, used, count - used, offset + used);
          if (result.bytesRead === 0) throw new Error("Unexpected EOF: " + file.relativePath);
          used += result.bytesRead;
        }
        digest.update(buffer);
        const name = file.relativePath.split("/").at(-1) + ".part-" + parts.length;
        const partPath = join(dirname(file.path), name);
        await writeFile(partPath, buffer, { flag: "wx" });
        parts.push({ name, sizeBytes: count });
        offset += count;
      }
    } finally {
      await source.close();
    }
    const sha256 = digest.digest("hex");
    if (sha256 !== manifestEntry.sha256) {
      throw new Error("Original offline checksum changed while splitting " + file.relativePath);
    }
    const descriptor = { schemaVersion: 1, sizeBytes: file.bytes, sha256, parts };
    await writeFile(file.path + ".parts.json", JSON.stringify(descriptor) + "\n", { flag: "wx" });
    await unlink(file.path);
    console.log("Split " + file.relativePath + " (" + file.bytes + " bytes) into " + parts.length + " assets");
  }
  console.log("Cloudflare static-asset preparation complete; " + largeAssets.length + " oversized SoundFont(s) converted.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  splitCloudflareAssets(process.argv[2] ?? DEFAULT_DIST).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
