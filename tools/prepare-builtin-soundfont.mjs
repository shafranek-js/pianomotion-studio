#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_SOURCE_FILE = path.join(repositoryRoot, "assets", "soundfonts", "MuseScore_General.sf3");
const DEFAULT_DESTINATION_DIR = path.join(repositoryRoot, "apps", "client", "public", "soundfonts", "musescore-general");
const DEFAULT_LICENSE_FILE = path.join(repositoryRoot, "docs", "licenses", "MuseScore_General_License.md");

export const BUILTIN_SOUNDFONT_DESCRIPTOR = Object.freeze({
  id: "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3",
  name: "MuseScore General v0.2",
  version: "0.2",
  format: "sf3",
  license: "MIT",
  licenseDocument: "MuseScore_General_License.md",
  sourceUrl: "https://ftp-osl.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSoundFontContainer(bytes, sourceFile) {
  if (bytes.byteLength < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "sfbk") {
    throw new Error(`Built-in SoundFont source is not an SF2/SF3 RIFF bank: ${sourceFile}`);
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.byteLength) {
    throw new Error(`Built-in SoundFont source has an invalid RIFF length: ${sourceFile}`);
  }
}

async function assertRegularFile(filePath, label) {
  const info = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label} was not found: ${filePath}`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a link or directory: ${filePath}`);
  }
}

async function assertOutputDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Built-in SoundFont output must be a real directory: ${directory}`);
  }
}

async function writeFileIfChanged(filePath, bytes) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Generated built-in SoundFont output must be a regular file: ${filePath}`);
    }
    const existingBytes = await readFile(filePath);
    if (existingBytes.equals(bytes)) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(filePath, bytes);
  return true;
}

/** Copies one pinned, licensed source bank into the generated public release assets. */
export async function prepareBuiltinSoundfont({
  sourceFile = DEFAULT_SOURCE_FILE,
  destinationDir = DEFAULT_DESTINATION_DIR,
  expectedSha256 = BUILTIN_SOUNDFONT_DESCRIPTOR.id,
} = {}) {
  const absoluteSourceFile = path.resolve(sourceFile);
  const absoluteDestinationDir = path.resolve(destinationDir);
  await assertRegularFile(absoluteSourceFile, "Built-in SoundFont source");
  const bytes = await readFile(absoluteSourceFile);
  assertSoundFontContainer(bytes, absoluteSourceFile);
  const digest = sha256(bytes);
  if (digest !== expectedSha256) {
    throw new Error(`Built-in SoundFont source SHA-256 mismatch: expected ${expectedSha256}, got ${digest}.`);
  }

  await assertOutputDirectory(absoluteDestinationDir);
  const assetFileName = `${digest}.sf3`;
  const manifest = {
    schemaVersion: 1,
    ...BUILTIN_SOUNDFONT_DESCRIPTOR,
    sha256: digest,
    byteLength: bytes.byteLength,
    assetPath: assetFileName,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const licenseBytes = await readFile(DEFAULT_LICENSE_FILE);
  const assetChanged = await writeFileIfChanged(path.join(absoluteDestinationDir, assetFileName), bytes);
  const licenseChanged = await writeFileIfChanged(path.join(absoluteDestinationDir, BUILTIN_SOUNDFONT_DESCRIPTOR.licenseDocument), licenseBytes);
  const manifestChanged = await writeFileIfChanged(path.join(absoluteDestinationDir, "manifest.json"), manifestBytes);
  return {
    manifest,
    assetPath: path.join(absoluteDestinationDir, assetFileName),
    manifestPath: path.join(absoluteDestinationDir, "manifest.json"),
    assetChanged,
    licenseChanged,
    manifestChanged,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareBuiltinSoundfont().then((result) => {
    console.log(`Prepared MuseScore General v0.2: ${result.manifest.byteLength} bytes, SHA-256 ${result.manifest.sha256}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
