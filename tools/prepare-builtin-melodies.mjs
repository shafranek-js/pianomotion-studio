#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_SOURCE_DIR = path.join(repositoryRoot, "builtin_melodies", "midi");
const DEFAULT_DESTINATION_DIR = path.join(repositoryRoot, "apps", "client", "public", "builtin-melodies");
const MANIFEST_FILE = "manifest.json";
const RESOURCE_FILE_PATTERN = /^files\/([a-f0-9]{64})\.mid$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMidiFileName(name) {
  return /\.(?:mid|midi)$/i.test(name);
}

function titleFromFileName(fileName) {
  return fileName.replace(/\.(?:mid|midi)$/i, "");
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) return true;
  }
  return false;
}

function assertSafeRelativeSourcePath(relativePath) {
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/") ||
      relativePath.split("/").some((segment) => !segment || segment === "." || segment === ".." || containsControlCharacter(segment))) {
    throw new Error(`The built-in melody source has an unsafe relative path: ${relativePath}`);
  }
}

export function assertNoCaseCollisions(relativePaths) {
  const seen = new Map();
  for (const relativePath of relativePaths) {
    const key = relativePath.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined && previous !== relativePath) {
      throw new Error(`Built-in melody source paths differ only by case: ${previous} and ${relativePath}`);
    }
    seen.set(key, relativePath);
  }
}

function assertMinimalMidiHeader(bytes, relativePath) {
  const fail = () => {
    throw new Error(`Built-in melody is not a structurally valid MIDI file: ${relativePath}`);
  };
  if (bytes.byteLength < 22 || bytes.toString("ascii", 0, 4) !== "MThd") fail();

  const headerLength = bytes.readUInt32BE(4);
  if (headerLength < 6 || 8 + headerLength + 8 > bytes.byteLength) fail();

  const format = bytes.readUInt16BE(8);
  const trackCount = bytes.readUInt16BE(10);
  const division = bytes.readUInt16BE(12);
  if (format > 2 || trackCount < 1 || division === 0) fail();

  const firstTrackOffset = 8 + headerLength;
  if (bytes.toString("ascii", firstTrackOffset, firstTrackOffset + 4) !== "MTrk") fail();
  const firstTrackLength = bytes.readUInt32BE(firstTrackOffset + 4);
  if (firstTrackLength > bytes.byteLength - firstTrackOffset - 8) fail();
}

async function collectMidiFiles(sourceDir) {
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && isMidiFileName(entry.name)) {
        const relativePath = path.relative(sourceDir, absolutePath).split(path.sep).join("/");
        assertSafeRelativeSourcePath(relativePath);
        result.push({ absolutePath, relativePath });
      }
    }
  }
  await visit(sourceDir);
  result.sort((left, right) => compareText(left.relativePath, right.relativePath));
  assertNoCaseCollisions(result.map((file) => file.relativePath));
  return result;
}

async function assertOutputDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Built-in melody output must be a real directory: ${directory}`);
  }
  const filesDirectory = path.join(directory, "files");
  try {
    const filesInfo = await lstat(filesDirectory);
    if (!filesInfo.isDirectory() || filesInfo.isSymbolicLink()) {
      throw new Error(`Built-in melody asset directory must be a real directory: ${filesDirectory}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(filesDirectory);
  }
  return filesDirectory;
}

async function writeFileIfChanged(filePath, bytes) {
  try {
    const existingInfo = await lstat(filePath);
    if (!existingInfo.isFile() || existingInfo.isSymbolicLink()) {
      throw new Error(`Generated built-in melody output must be a regular file: ${filePath}`);
    }
    const existingBytes = await readFile(filePath);
    if (existingBytes.equals(bytes)) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(filePath, bytes);
  return true;
}

function previousGeneratedPaths(previousManifest, destinationDir) {
  if (!previousManifest || previousManifest.schemaVersion !== 1 || !Array.isArray(previousManifest.entries)) return [];
  const paths = new Set();
  for (const entry of previousManifest.entries) {
    const match = typeof entry?.assetPath === "string" ? RESOURCE_FILE_PATTERN.exec(entry.assetPath) : null;
    if (match && typeof entry.sha256 === "string" && match[1] === entry.sha256) {
      paths.add(path.join(destinationDir, ...entry.assetPath.split("/")));
    }
  }
  return [...paths];
}

/**
 * Copies only MIDI files from the canonical built-in source into a deterministic,
 * content-addressed public catalog. The source tree is read-only.
 */
export async function prepareBuiltinMelodies({ sourceDir = DEFAULT_SOURCE_DIR, destinationDir = DEFAULT_DESTINATION_DIR } = {}) {
  const absoluteSourceDir = path.resolve(sourceDir);
  const absoluteDestinationDir = path.resolve(destinationDir);
  const sourceInfo = await stat(absoluteSourceDir).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Built-in melody source directory was not found: ${absoluteSourceDir}`);
    }
    throw error;
  });
  if (!sourceInfo.isDirectory()) {
    throw new Error(`Built-in melody source path is not a directory: ${absoluteSourceDir}`);
  }

  const files = await collectMidiFiles(absoluteSourceDir);
  if (files.length === 0) {
    throw new Error(`No .mid or .midi files were found in ${absoluteSourceDir}`);
  }

  const entries = [];
  const assets = new Map();
  let totalBytes = 0;
  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    assertMinimalMidiHeader(bytes, file.relativePath);
    const digest = sha256(bytes);
    const assetPath = `files/${digest}.mid`;
    const id = sha256(Buffer.from(file.relativePath, "utf8"));
    entries.push({
      id,
      title: titleFromFileName(path.posix.basename(file.relativePath)),
      fileName: file.relativePath,
      assetPath,
      sha256: digest,
      byteLength: bytes.byteLength,
    });
    assets.set(assetPath, bytes);
    totalBytes += bytes.byteLength;
  }

  entries.sort((left, right) => compareText(left.title, right.title) || compareText(left.fileName, right.fileName));
  const manifest = { schemaVersion: 1, entries };
  const filesDirectory = await assertOutputDirectory(absoluteDestinationDir);
  const manifestPath = path.join(absoluteDestinationDir, MANIFEST_FILE);
  let previousPaths = [];
  try {
    const previousManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    previousPaths = previousGeneratedPaths(previousManifest, absoluteDestinationDir);
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  for (const [assetPath, bytes] of assets) {
    const assetFile = path.join(absoluteDestinationDir, ...assetPath.split("/"));
    await writeFileIfChanged(assetFile, bytes);
  }
  const currentPaths = new Set([...assets.keys()].map((assetPath) => path.join(absoluteDestinationDir, ...assetPath.split("/"))));
  for (const previousPath of previousPaths) {
    if (currentPaths.has(previousPath)) continue;
    const relativeToFiles = path.relative(filesDirectory, previousPath);
    if (relativeToFiles.startsWith("..") || path.isAbsolute(relativeToFiles)) continue;
    await rm(previousPath, { force: true });
  }

  await writeFileIfChanged(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  return {
    manifest,
    manifestPath,
    melodyCount: entries.length,
    uniqueAssetCount: assets.size,
    totalBytes,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareBuiltinMelodies().then((result) => {
    process.stdout.write(`${JSON.stringify({
      manifestPath: result.manifestPath,
      melodyCount: result.melodyCount,
      uniqueAssetCount: result.uniqueAssetCount,
      totalBytes: result.totalBytes,
    }, null, 2)}\n`);
  }).catch((error) => {
    console.error("Failed to prepare built-in melodies:", error);
    process.exitCode = 1;
  });
}
