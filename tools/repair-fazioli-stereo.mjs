import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FAZIOLI_V30_SHA256 = "db1b7d2ecd5c8a68594f03687c51811e3c944b35be4c5bc081f2aba217252fbb";
export const FAZIOLI_V30_SIZE_BYTES = 313_732_114;

const COPY_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_SF2_BYTES = 1024 * 1024 * 1024;
const MAX_PDAT_BYTES = 16 * 1024 * 1024;
const SHDR_ENTRY_BYTES = 46;
const TABLE_ENTRY_BYTES = new Map([
  ["phdr", 38], ["pbag", 4], ["pmod", 10], ["pgen", 4],
  ["inst", 22], ["ibag", 4], ["imod", 10], ["igen", 4], ["shdr", 46],
]);
const REQUIRED_TABLES = ["phdr", "pbag", "pgen", "inst", "ibag", "igen", "shdr"];
const EXPECTED_PRESETS = [
  "Fazioli Grand F308",
  "Fazioli Dynamic",
  "Fazioli Dark",
  "Fazioli Extra Dark",
];
const EXPECTED_SAMPLES = new Map([
  [287, {
    name: "C214 XY-R PD f D#6-L",
    start: 155_978_111,
    end: 156_139_559,
    loopStart: 156_104_304,
    loopEnd: 156_139_551,
    sampleRate: 48_000,
    originalPitch: 1,
    pitchCorrection: 0,
    sampleLink: 288,
    sampleType: 4,
  }],
  [288, {
    name: "C214 XY-R PD f D#6-R",
    start: 156_139_605,
    end: 156_301_053,
    loopStart: 156_282_814,
    loopEnd: 156_301_045,
    sampleRate: 48_000,
    originalPitch: 1,
    pitchCorrection: 0,
    sampleLink: 0,
    sampleType: 1,
  }],
]);

function fail(message) {
  throw new Error(message);
}

async function readExact(fileHandle, position, length, context) {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
    fail("Invalid read range for " + context + ".");
  }
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const result = await fileHandle.read(buffer, total, length - total, position + total);
    if (result.bytesRead === 0) fail("Unexpected end of file while reading " + context + ".");
    total += result.bytesRead;
  }
  return buffer;
}

async function writeExact(fileHandle, buffer, position) {
  let total = 0;
  while (total < buffer.length) {
    const result = await fileHandle.write(buffer, total, buffer.length - total, position + total);
    if (result.bytesWritten === 0) fail("Could not complete a write to the repair copy.");
    total += result.bytesWritten;
  }
}

async function chunksWithin(fileHandle, start, end, context) {
  const chunks = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) fail(context + " contains a truncated chunk header.");
    const header = await readExact(fileHandle, offset, 8, context + " chunk header");
    const tag = header.toString("ascii", 0, 4);
    const size = header.readUInt32LE(4);
    const dataOffset = offset + 8;
    const paddedEnd = dataOffset + size + (size & 1);
    if (paddedEnd > end || paddedEnd < dataOffset) fail(context + " chunk " + tag + " extends beyond its list.");
    chunks.push({ tag, dataOffset, size });
    offset = paddedEnd;
  }
  if (offset !== end) fail(context + " has an invalid chunk boundary.");
  return chunks;
}

function decodeName(buffer) {
  const nul = buffer.indexOf(0);
  return buffer.subarray(0, nul < 0 ? buffer.length : nul).toString("ascii");
}

function parseSampleHeaders(bytes) {
  if (bytes.length % SHDR_ENTRY_BYTES !== 0) fail("The shdr table is not a whole number of sample records.");
  const samples = [];
  for (let index = 0; index < bytes.length / SHDR_ENTRY_BYTES; index++) {
    const base = index * SHDR_ENTRY_BYTES;
    samples.push({
      index,
      name: decodeName(bytes.subarray(base, base + 20)),
      start: bytes.readUInt32LE(base + 20),
      end: bytes.readUInt32LE(base + 24),
      loopStart: bytes.readUInt32LE(base + 28),
      loopEnd: bytes.readUInt32LE(base + 32),
      sampleRate: bytes.readUInt32LE(base + 36),
      originalPitch: bytes.readUInt8(base + 40),
      pitchCorrection: bytes.readInt8(base + 41),
      sampleLink: bytes.readUInt16LE(base + 42),
      sampleType: bytes.readUInt16LE(base + 44),
    });
  }
  return samples;
}

function parseBagTable(bytes, label, generatorCount) {
  if (bytes.length % 4 !== 0) fail("The " + label + " table has an invalid size.");
  const entries = [];
  let previousGeneratorIndex = -1;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const generatorIndex = bytes.readUInt16LE(offset);
    if (generatorIndex < previousGeneratorIndex || generatorIndex > generatorCount) {
      fail("The " + label + " table has an invalid generator index.");
    }
    entries.push({ generatorIndex, modulatorIndex: bytes.readUInt16LE(offset + 2) });
    previousGeneratorIndex = generatorIndex;
  }
  return entries;
}

function parseGeneratorTable(bytes, label) {
  if (bytes.length % 4 !== 0) fail("The " + label + " table has an invalid size.");
  const entries = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    entries.push({ operator: bytes.readUInt16LE(offset), amount: bytes.readUInt16LE(offset + 2) });
  }
  return entries;
}

function generatorValues(bags, generators, firstBag, lastBag, operator, context) {
  if (firstBag < 0 || lastBag < firstBag || lastBag >= bags.length) {
    fail(context + " references an invalid bag range.");
  }
  const values = [];
  for (let bagIndex = firstBag; bagIndex < lastBag; bagIndex++) {
    const firstGenerator = bags[bagIndex].generatorIndex;
    const lastGenerator = bags[bagIndex + 1].generatorIndex;
    if (lastGenerator < firstGenerator || lastGenerator > generators.length) {
      fail(context + " references an invalid generator range.");
    }
    for (let generatorIndex = firstGenerator; generatorIndex < lastGenerator; generatorIndex++) {
      const generator = generators[generatorIndex];
      if (generator.operator === operator) values.push(generator.amount);
    }
  }
  return values;
}

function parseReferences(tables, samples) {
  const phdrBytes = tables.get("phdr");
  const pbagBytes = tables.get("pbag");
  const pgenBytes = tables.get("pgen");
  const instBytes = tables.get("inst");
  const ibagBytes = tables.get("ibag");
  const igenBytes = tables.get("igen");

  if (phdrBytes.length % 38 !== 0 || instBytes.length % 22 !== 0) {
    fail("The preset or instrument table has an invalid size.");
  }
  const pgens = parseGeneratorTable(pgenBytes, "pgen");
  const igens = parseGeneratorTable(igenBytes, "igen");
  const pbags = parseBagTable(pbagBytes, "pbag", pgens.length);
  const ibags = parseBagTable(ibagBytes, "ibag", igens.length);

  const presets = [];
  for (let offset = 0; offset < phdrBytes.length; offset += 38) {
    presets.push({
      name: decodeName(phdrBytes.subarray(offset, offset + 20)),
      program: phdrBytes.readUInt16LE(offset + 20),
      bank: phdrBytes.readUInt16LE(offset + 22),
      bagIndex: phdrBytes.readUInt16LE(offset + 24),
    });
  }
  const instruments = [];
  for (let offset = 0; offset < instBytes.length; offset += 22) {
    instruments.push({
      name: decodeName(instBytes.subarray(offset, offset + 20)),
      bagIndex: instBytes.readUInt16LE(offset + 20),
    });
  }
  if (presets.length < 2 || presets.at(-1).name !== "EOP") fail("The preset table is missing its terminal EOP record.");
  if (instruments.length < 2 || instruments.at(-1).name !== "EOI") fail("The instrument table is missing its terminal EOI record.");

  const realSampleCount = samples.at(-1)?.name === "EOS" ? samples.length - 1 : samples.length;
  const instrumentSamples = [];
  const instrumentCount = instruments.length - 1;
  for (let instrumentIndex = 0; instrumentIndex < instrumentCount; instrumentIndex++) {
    const found = generatorValues(
      ibags,
      igens,
      instruments[instrumentIndex].bagIndex,
      instruments[instrumentIndex + 1].bagIndex,
      53,
      "Instrument " + instruments[instrumentIndex].name,
    );
    const sampleIds = new Set(found);
    for (const sampleId of sampleIds) {
      if (sampleId >= realSampleCount) fail("An instrument references a sample outside the sample table.");
    }
    instrumentSamples.push(sampleIds);
  }

  const instrumentIdsBySample = new Map();
  for (const targetId of [287, 288]) instrumentIdsBySample.set(targetId, []);
  for (let instrumentIndex = 0; instrumentIndex < instrumentSamples.length; instrumentIndex++) {
    for (const targetId of [287, 288]) {
      if (instrumentSamples[instrumentIndex].has(targetId)) instrumentIdsBySample.get(targetId).push(instrumentIndex);
    }
  }

  const resultPresets = [];
  for (let presetIndex = 0; presetIndex < presets.length - 1; presetIndex++) {
    const preset = presets[presetIndex];
    const instrumentIds = new Set(generatorValues(
      pbags,
      pgens,
      preset.bagIndex,
      presets[presetIndex + 1].bagIndex,
      41,
      "Preset " + preset.name,
    ));
    const sampleIds = new Set();
    for (const instrumentId of instrumentIds) {
      if (instrumentId >= instrumentCount) fail("Preset " + preset.name + " references an instrument outside the instrument table.");
      for (const sampleId of instrumentSamples[instrumentId]) sampleIds.add(sampleId);
    }
    resultPresets.push({
      name: preset.name,
      program: preset.program,
      bank: preset.bank,
      instrumentIds: [...instrumentIds].sort((a, b) => a - b),
      sampleIds: [...sampleIds].sort((a, b) => a - b),
      usesSample287: sampleIds.has(287),
      usesSample288: sampleIds.has(288),
    });
  }
  return {
    presets: resultPresets,
    instrumentIdsBySample: Object.fromEntries(
      [...instrumentIdsBySample].map(([sampleId, ids]) => [sampleId, ids]),
    ),
  };
}

async function inspectOpenFile(fileHandle, fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 12 || fileSize > MAX_SF2_BYTES) {
    fail("The file size is outside the supported SF2 inspection range.");
  }
  const header = await readExact(fileHandle, 0, 12, "RIFF header");
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "sfbk") {
    fail("The input is not an SF2 RIFF/sfbk file.");
  }
  const riffEnd = header.readUInt32LE(4) + 8;
  if (riffEnd !== fileSize) fail("The RIFF size does not match the file size.");

  let pdtaTables = null;
  let shdrOffset = -1;
  let sampleDataCount = -1;
  for (const chunk of await chunksWithin(fileHandle, 12, riffEnd, "RIFF")) {
    if (chunk.tag !== "LIST") continue;
    if (chunk.size < 4) fail("An SF2 LIST chunk is missing its list type.");
    const listType = (await readExact(fileHandle, chunk.dataOffset, 4, "LIST type")).toString("ascii");
    if (listType === "sdta") {
      const children = await chunksWithin(fileHandle, chunk.dataOffset + 4, chunk.dataOffset + chunk.size, "sdta");
      const smplChunks = children.filter((child) => child.tag === "smpl");
      if (smplChunks.length !== 1 || (smplChunks[0].size & 1) !== 0) {
        fail("The sf2 sdta list must contain exactly one complete 16-bit smpl chunk.");
      }
      if (sampleDataCount !== -1) fail("The SF2 file contains more than one sdta sample-data list.");
      sampleDataCount = smplChunks[0].size / 2;
    } else if (listType === "pdta") {
      if (pdtaTables !== null) fail("The SF2 file contains more than one pdta list.");
      if (chunk.size > MAX_PDAT_BYTES) fail("The pdta metadata exceeds the 16 MiB inspection limit.");
      const children = await chunksWithin(fileHandle, chunk.dataOffset + 4, chunk.dataOffset + chunk.size, "pdta");
      const tables = new Map();
      for (const child of children) {
        const stride = TABLE_ENTRY_BYTES.get(child.tag);
        if (stride === undefined) continue;
        if (tables.has(child.tag)) fail("The pdta list contains duplicate " + child.tag + " tables.");
        if (child.size % stride !== 0) fail("The pdta " + child.tag + " table has an invalid entry size.");
        tables.set(child.tag, await readExact(fileHandle, child.dataOffset, child.size, "pdta " + child.tag));
        if (child.tag === "shdr") shdrOffset = child.dataOffset;
      }
      const missing = REQUIRED_TABLES.filter((tag) => !tables.has(tag));
      if (missing.length > 0) fail("The pdta list is missing required tables: " + missing.join(", ") + ".");
      pdtaTables = tables;
    }
  }

  if (sampleDataCount < 0) fail("The SF2 file is missing its sdta/smpl sample data.");
  if (pdtaTables === null || shdrOffset < 0) fail("The SF2 file is missing its pdta/shdr metadata.");
  const shdrBytes = pdtaTables.get("shdr");
  const samples = parseSampleHeaders(shdrBytes);
  const references = parseReferences(pdtaTables, samples);
  return { fileSize, sampleDataCount, shdrOffset, shdrBytes, samples, references };
}

export async function inspectSf2File(filePath) {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) fail("The input path is not a regular file.");
    return await inspectOpenFile(handle, stats.size);
  } finally {
    await handle.close();
  }
}

function assertExpectedPresetCoverage(metadata) {
  const presets = metadata.references.presets;
  const affected = presets.filter((preset) => preset.usesSample287 || preset.usesSample288);
  if (affected.length !== EXPECTED_PRESETS.length) {
    fail("The target sample pair is not referenced by exactly the four expected Fazioli presets.");
  }
  for (let index = 0; index < EXPECTED_PRESETS.length; index++) {
    const preset = affected[index];
    if (
      preset.name !== EXPECTED_PRESETS[index]
      || preset.program !== index
      || preset.bank !== 0
      || !preset.usesSample287
      || !preset.usesSample288
    ) {
      fail("The target sample pair is not referenced by the expected four presets in the expected order.");
    }
  }
  const leftInstruments = metadata.references.instrumentIdsBySample[287] ?? [];
  const rightInstruments = metadata.references.instrumentIdsBySample[288] ?? [];
  if (leftInstruments.length === 0 || leftInstruments.join(",") !== rightInstruments.join(",")) {
    fail("The target samples are not referenced by the same instrument set.");
  }
}

export function validateFazioliV30Metadata(metadata) {
  if (metadata.samples.length !== 291 || metadata.samples[290]?.name !== "EOS") {
    fail("The pinned v3.0 sample table does not have the expected 290 samples and terminal EOS record.");
  }
  for (const [index, expected] of EXPECTED_SAMPLES) {
    const sample = metadata.samples[index];
    if (!sample) fail("The target sample index " + index + " is missing.");
    const sameName = metadata.samples.filter((candidate) => candidate.name === expected.name);
    if (sameName.length !== 1) fail("The target sample name " + expected.name + " is not unique.");
    for (const [field, value] of Object.entries(expected)) {
      if (field === "name") continue;
      if (sample[field] !== value) {
        fail("Sample " + index + " has unexpected " + field + " value " + sample[field] + ".");
      }
    }
    if (sample.name !== expected.name) fail("Sample " + index + " has an unexpected name.");
    if (sample.end > metadata.sampleDataCount || sample.start >= sample.end) {
      fail("Sample " + index + " has invalid PCM bounds.");
    }
    if (sample.loopStart < sample.start || sample.loopEnd > sample.end || sample.loopStart > sample.loopEnd) {
      fail("Sample " + index + " has invalid loop bounds.");
    }
  }
  const left = metadata.samples[287];
  const right = metadata.samples[288];
  if (left.end - left.start !== 161_448 || right.end - right.start !== 161_448 || left.sampleRate !== right.sampleRate) {
    fail("The target samples do not have matching 161,448-frame, 48 kHz channel data.");
  }
  assertExpectedPresetCoverage(metadata);
  return [
    { sampleIndex: 288, field: "sampleLink", offset: metadata.shdrOffset + 288 * SHDR_ENTRY_BYTES + 42, before: 0, after: 287 },
    { sampleIndex: 288, field: "sampleType", offset: metadata.shdrOffset + 288 * SHDR_ENTRY_BYTES + 44, before: 1, after: 2 },
  ];
}

function validateRepairedMetadata(metadata) {
  const left = metadata.samples[287];
  const right = metadata.samples[288];
  if (
    left?.name !== "C214 XY-R PD f D#6-L"
    || left.sampleLink !== 288
    || left.sampleType !== 4
    || right?.name !== "C214 XY-R PD f D#6-R"
    || right.sampleLink !== 287
    || right.sampleType !== 2
  ) {
    fail("The repair copy did not produce reciprocal left/right sample links.");
  }
  if (
    left.end - left.start !== 161_448
    || right.end - right.start !== 161_448
    || left.sampleRate !== 48_000
    || right.sampleRate !== 48_000
  ) {
    fail("The repaired pair no longer has matching 161,448-frame, 48 kHz channels.");
  }
  assertExpectedPresetCoverage(metadata);
}

async function hashOpenFile(fileHandle, fileSize) {
  const hash = createHash("sha256");
  for (let position = 0; position < fileSize; position += COPY_CHUNK_BYTES) {
    const length = Math.min(COPY_CHUNK_BYTES, fileSize - position);
    hash.update(await readExact(fileHandle, position, length, "file hash"));
  }
  return hash.digest("hex");
}

function validatePatches(patches, fileSize) {
  if (!Array.isArray(patches) || patches.length === 0) fail("At least one explicit 16-bit patch is required.");
  const sorted = [...patches].sort((a, b) => a.offset - b.offset);
  for (let index = 0; index < sorted.length; index++) {
    const patch = sorted[index];
    if (
      !Number.isSafeInteger(patch.offset)
      || patch.offset < 0
      || patch.offset + 2 > fileSize
      || !Number.isInteger(patch.before)
      || patch.before < 0
      || patch.before > 0xffff
      || !Number.isInteger(patch.after)
      || patch.after < 0
      || patch.after > 0xffff
      || patch.before === patch.after
    ) {
      fail("A repair patch has an invalid offset or 16-bit value.");
    }
    if (index > 0 && sorted[index - 1].offset + 2 > patch.offset) {
      fail("Repair patches overlap.");
    }
  }
  return sorted;
}

async function copyOpenFileWithPatches(sourceHandle, outputPath, fileSize, expectedSourceHash, patches) {
  const absoluteOutput = path.resolve(outputPath);
  const sortedPatches = validatePatches(patches, fileSize);
  let outputHandle = null;
  let createdOutput = false;
  let success = false;
  try {
    outputHandle = await open(absoluteOutput, "wx");
    createdOutput = true;
    const sourceHash = createHash("sha256");
    const outputHash = createHash("sha256");
    let applied = 0;
    for (let position = 0; position < fileSize;) {
      let end = Math.min(position + COPY_CHUNK_BYTES, fileSize);
      const crossingPatch = sortedPatches.find((patch) => patch.offset < end && patch.offset + 2 > end);
      if (crossingPatch && end < fileSize) end = crossingPatch.offset;
      const sourceBytes = await readExact(sourceHandle, position, end - position, "source file copy");
      sourceHash.update(sourceBytes);
      const outputBytes = Buffer.from(sourceBytes);
      for (const patch of sortedPatches) {
        if (patch.offset < position || patch.offset + 2 > end) continue;
        const localOffset = patch.offset - position;
        const current = outputBytes.readUInt16LE(localOffset);
        if (current !== patch.before) fail("The source field " + patch.field + " changed before it could be patched.");
        outputBytes.writeUInt16LE(patch.after, localOffset);
        applied++;
      }
      outputHash.update(outputBytes);
      await writeExact(outputHandle, outputBytes, position);
      position = end;
    }
    if (applied !== sortedPatches.length) fail("Not all explicit repair fields were written.");
    const copiedSourceHash = sourceHash.digest("hex");
    if (copiedSourceHash !== expectedSourceHash) {
      fail("The source file changed while it was being copied; the incomplete output was removed.");
    }
    await outputHandle.sync();
    success = true;
    return { outputPath: absoluteOutput, outputSha256: outputHash.digest("hex") };
  } finally {
    if (outputHandle) await outputHandle.close();
    if (createdOutput && !success) await unlink(absoluteOutput).catch(() => {});
  }
}

export async function copyFileWithPatches(sourcePath, outputPath, expectedSourceHash, patches) {
  const resolvedSource = path.resolve(sourcePath);
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedSource === resolvedOutput) fail("The repair output must be a separate file from the source.");
  const sourceHandle = await open(resolvedSource, "r");
  try {
    const stats = await sourceHandle.stat();
    if (!stats.isFile()) fail("The source path is not a regular file.");
    const sourceHash = await hashOpenFile(sourceHandle, stats.size);
    if (sourceHash !== expectedSourceHash) fail("The source SHA-256 does not match the required hash.");
    return await copyOpenFileWithPatches(sourceHandle, resolvedOutput, stats.size, expectedSourceHash, patches);
  } finally {
    await sourceHandle.close();
  }
}

function assertOutputPath(sourcePath, outputPath) {
  if (path.resolve(sourcePath) === path.resolve(outputPath)) fail("The repair output must be a new path.");
  if (!path.basename(outputPath).toLowerCase().endsWith(".repaired.sf2")) {
    fail("The output filename must end in .repaired.sf2.");
  }
}

export async function repairFazioliV30Stereo(sourcePath, outputPath) {
  const resolvedSource = path.resolve(sourcePath);
  const resolvedOutput = path.resolve(outputPath);
  assertOutputPath(resolvedSource, resolvedOutput);
  const sourceHandle = await open(resolvedSource, "r");
  try {
    const stats = await sourceHandle.stat();
    if (!stats.isFile()) fail("The source path is not a regular file.");
    if (stats.size !== FAZIOLI_V30_SIZE_BYTES) fail("The input is not the pinned v3.0 file size.");
    const sourceHash = await hashOpenFile(sourceHandle, stats.size);
    if (sourceHash !== FAZIOLI_V30_SHA256) {
      fail("The input SHA-256 is not the pinned Fazioli-F308-v3.0 bank; no output was written.");
    }
    const before = await inspectOpenFile(sourceHandle, stats.size);
    const patches = validateFazioliV30Metadata(before);
    const copied = await copyOpenFileWithPatches(
      sourceHandle,
      resolvedOutput,
      stats.size,
      FAZIOLI_V30_SHA256,
      patches,
    );
    try {
      const afterHandle = await open(resolvedOutput, "r");
      let after;
      try {
        const afterStats = await afterHandle.stat();
        after = await inspectOpenFile(afterHandle, afterStats.size);
      } finally {
        await afterHandle.close();
      }
      validateRepairedMetadata(after);
      const expectedShdr = Buffer.from(before.shdrBytes);
      for (const patch of patches) {
        expectedShdr.writeUInt16LE(patch.after, patch.offset - before.shdrOffset);
      }
      if (!expectedShdr.equals(after.shdrBytes)) {
        fail("The output shdr table differs from the source beyond the two authorized fields.");
      }
      return {
        sourcePath: resolvedSource,
        sourceSizeBytes: stats.size,
        sourceSha256: sourceHash,
        outputPath: copied.outputPath,
        outputSizeBytes: stats.size,
        outputSha256: copied.outputSha256,
        changedFields: patches.map((patch) => ({
          sampleIndex: patch.sampleIndex,
          field: patch.field,
          before: patch.before,
          after: patch.after,
        })),
        pair: {
          left: { index: 287, name: before.samples[287].name, sampleType: 4, sampleLink: 288, frames: 161_448, sampleRate: 48_000 },
          right: { index: 288, name: after.samples[288].name, sampleType: 2, sampleLink: 287, frames: 161_448, sampleRate: 48_000 },
        },
        presets: after.references.presets.map(({ name, program, bank, usesSample287, usesSample288 }) => ({
          name, program, bank, usesSample287, usesSample288,
        })),
        outputValidated: true,
      };
    } catch (error) {
      await unlink(resolvedOutput).catch(() => {});
      throw error;
    }
  } finally {
    await sourceHandle.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    fail("Usage: node tools/repair-fazioli-stereo.mjs <Fazioli-F308-v3.0.sf2> <new-copy.repaired.sf2>");
  }
  const report = await repairFazioliV30Stereo(args[0], args[1]);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write("Fazioli repair failed: " + error.message + "\n");
    process.exitCode = 1;
  });
}
