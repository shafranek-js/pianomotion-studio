import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBuiltinSoundfont } from "../../tools/prepare-builtin-soundfont.mjs";

const temporaryDirectories: string[] = [];

function smallSoundFontFixture(): Buffer {
  const bytes = Buffer.alloc(12);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(4, 4);
  bytes.write("sfbk", 8, "ascii");
  return bytes;
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pianomotion-builtin-soundfont-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("prepareBuiltinSoundfont", () => {
  it("writes a deterministic content-addressed bank and descriptor without touching other files", async () => {
    const root = await makeDirectory();
    const sourceFile = path.join(root, "source.sf3");
    const destinationDir = path.join(root, "public", "soundfonts");
    const bytes = smallSoundFontFixture();
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(sourceFile, bytes);
    await mkdir(destinationDir, { recursive: true });
    const unrelatedPath = path.join(destinationDir, "unrelated.txt");
    await writeFile(unrelatedPath, "preserve this file");

    const first = await prepareBuiltinSoundfont({ sourceFile, destinationDir, expectedSha256 });
    const second = await prepareBuiltinSoundfont({ sourceFile, destinationDir, expectedSha256 });

    expect(first.manifest).toEqual(second.manifest);
    expect(first.assetChanged).toBe(true);
    expect(first.manifestChanged).toBe(true);
    expect(second.assetChanged).toBe(false);
    expect(second.manifestChanged).toBe(false);
    expect(await readFile(first.assetPath)).toEqual(bytes);
    expect(await readFile(first.manifestPath, "utf8")).toBe(`${JSON.stringify(first.manifest, null, 2)}\n`);
    expect(await readFile(path.join(destinationDir, first.manifest.licenseDocument), "utf8")).toContain("The acknowledgements and copyright notices above must be included");
    expect(await readFile(unrelatedPath, "utf8")).toBe("preserve this file");
  });

  it("rejects source content that does not match the pinned hash", async () => {
    const root = await makeDirectory();
    const sourceFile = path.join(root, "source.sf3");
    await writeFile(sourceFile, smallSoundFontFixture());

    await expect(prepareBuiltinSoundfont({ sourceFile, destinationDir: path.join(root, "public"), expectedSha256: "0".repeat(64) }))
      .rejects.toThrow(/SHA-256 mismatch/i);
  });

  it("rejects a file that is not an SF2/SF3 RIFF bank", async () => {
    const root = await makeDirectory();
    const sourceFile = path.join(root, "source.sf3");
    const invalidBytes = Buffer.from("not an sf3 bank");
    await writeFile(sourceFile, invalidBytes);
    const expectedSha256 = createHash("sha256").update(invalidBytes).digest("hex");

    await expect(prepareBuiltinSoundfont({ sourceFile, destinationDir: path.join(root, "public"), expectedSha256 }))
      .rejects.toThrow(/not an SF2\/SF3 RIFF bank/i);
  });
});
