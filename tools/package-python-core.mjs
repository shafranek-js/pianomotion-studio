#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptDir, '..');
const sourceDir = path.join(webDir, 'python-core', 'handthesia_core');
const publicRoot = path.join(webDir, 'apps', 'client', 'public', 'python-core');
const publicPackageDir = path.join(publicRoot, 'handthesia_core');

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

const filenames = (await readdir(sourceDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.py'))
  .map((entry) => entry.name)
  .sort();

const moduleHashes = {};

for (const filename of filenames) {
  const relativePath = `handthesia_core/${filename}`;
  const fileBytes = await readFile(path.join(sourceDir, filename));
  moduleHashes[relativePath] = sha256(fileBytes);
}

const canonicalEngineInput = Buffer.from(
  JSON.stringify({ files: Object.fromEntries(Object.entries(moduleHashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }),
  'utf8'
);

const manifest = {
  schemaVersion: 1,
  engineVersion: sha256(canonicalEngineInput),
  entrypoint: 'handthesia_core.api:analyze_midi',
  replanEntrypoint: 'handthesia_core.api:replan_document',
  pythonPackages: ['pretty_midi', 'mido', 'numpy'],
  files: moduleHashes,
  desktopSourceCommit: 'f8189c021d9235005fb35faa2c8cfbc09a3768a0',
  desktopVersion: 'v26.1.20'
};

const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;

await mkdir(publicPackageDir, { recursive: true });
for (const filename of filenames) {
  await copyFile(path.join(sourceDir, filename), path.join(publicPackageDir, filename));
}

await writeFile(path.join(sourceDir, 'source_manifest.json'), manifestBytes, 'utf8');
await writeFile(path.join(publicRoot, 'source_manifest.json'), manifestBytes, 'utf8');
await writeFile(path.join(publicPackageDir, 'source_manifest.json'), manifestBytes, 'utf8');

process.stdout.write(`Packaged ${filenames.length} PianoMotion core modules; engineVersion=${manifest.engineVersion}\n`);
