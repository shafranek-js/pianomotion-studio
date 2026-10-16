import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyFileWithPatches,
  inspectSf2File,
  repairFazioliV30Stereo,
  validateFazioliV30Metadata,
} from "./repair-fazioli-stereo.mjs";

const PRESET_NAMES = [
  "Fazioli Grand F308",
  "Fazioli Dynamic",
  "Fazioli Dark",
  "Fazioli Extra Dark",
];

function makeChunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, Buffer.alloc(payload.length & 1)]);
}

function makeList(type, children) {
  return makeChunk("LIST", Buffer.concat([Buffer.from(type, "ascii"), ...children]));
}

function writeFixedName(bytes, offset, name, length) {
  Buffer.from(name, "ascii").copy(bytes, offset, 0, Math.min(name.length, length));
}

function makeFixtureSf2() {
  const shdr = Buffer.alloc(291 * 46);
  for (let index = 0; index < 291; index++) {
    const base = index * 46;
    writeFixedName(shdr, base, index === 290 ? "EOS" : "Sample " + index, 20);
    shdr.writeUInt32LE(0, base + 20);
    shdr.writeUInt32LE(1, base + 24);
    shdr.writeUInt32LE(0, base + 28);
    shdr.writeUInt32LE(0, base + 32);
    shdr.writeUInt32LE(48_000, base + 36);
    shdr.writeUInt8(60, base + 40);
    shdr.writeInt8(0, base + 41);
    shdr.writeUInt16LE(0, base + 42);
    shdr.writeUInt16LE(1, base + 44);
  }
  const left = 287 * 46;
  writeFixedName(shdr, left, "C214 XY-R PD f D#6-L", 20);
  shdr.writeUInt32LE(1_000, left + 20);
  shdr.writeUInt32LE(162_448, left + 24);
  shdr.writeUInt32LE(162_000, left + 28);
  shdr.writeUInt32LE(162_440, left + 32);
  shdr.writeUInt32LE(48_000, left + 36);
  shdr.writeUInt8(1, left + 40);
  shdr.writeInt8(0, left + 41);
  shdr.writeUInt16LE(288, left + 42);
  shdr.writeUInt16LE(4, left + 44);

  const right = 288 * 46;
  writeFixedName(shdr, right, "C214 XY-R PD f D#6-R", 20);
  shdr.writeUInt32LE(162_500, right + 20);
  shdr.writeUInt32LE(323_948, right + 24);
  shdr.writeUInt32LE(323_000, right + 28);
  shdr.writeUInt32LE(323_940, right + 32);
  shdr.writeUInt32LE(48_000, right + 36);
  shdr.writeUInt8(1, right + 40);
  shdr.writeInt8(0, right + 41);
  shdr.writeUInt16LE(0, right + 42);
  shdr.writeUInt16LE(1, right + 44);

  const phdr = Buffer.alloc(5 * 38);
  const presetInstrumentIds = [4, 5, 2, 3, 0, 1, 6, 7];
  for (let index = 0; index < 4; index++) {
    const offset = index * 38;
    writeFixedName(phdr, offset, PRESET_NAMES[index], 20);
    phdr.writeUInt16LE(index, offset + 20);
    phdr.writeUInt16LE(0, offset + 22);
    phdr.writeUInt16LE(index * 2, offset + 24);
  }
  writeFixedName(phdr, 4 * 38, "EOP", 20);
  phdr.writeUInt16LE(8, 4 * 38 + 24);

  const pbag = Buffer.alloc(9 * 4);
  for (let index = 0; index < 9; index++) pbag.writeUInt16LE(index, index * 4);
  const pgen = Buffer.alloc(8 * 4);
  for (let index = 0; index < 8; index++) {
    pgen.writeUInt16LE(41, index * 4);
    pgen.writeUInt16LE(presetInstrumentIds[index], index * 4 + 2);
  }

  const inst = Buffer.alloc(9 * 22);
  for (let index = 0; index < 8; index++) {
    const offset = index * 22;
    writeFixedName(inst, offset, "Instrument " + index, 20);
    inst.writeUInt16LE(index * 2, offset + 20);
  }
  writeFixedName(inst, 8 * 22, "EOI", 20);
  inst.writeUInt16LE(16, 8 * 22 + 20);

  const ibag = Buffer.alloc(17 * 4);
  for (let index = 0; index < 17; index++) ibag.writeUInt16LE(index, index * 4);
  const igen = Buffer.alloc(16 * 4);
  for (let index = 0; index < 16; index++) {
    igen.writeUInt16LE(53, index * 4);
    igen.writeUInt16LE(index % 2 === 0 ? 287 : 288, index * 4 + 2);
  }

  const pdta = makeList("pdta", [
    makeChunk("phdr", phdr),
    makeChunk("pbag", pbag),
    makeChunk("pmod", Buffer.alloc(10)),
    makeChunk("pgen", pgen),
    makeChunk("inst", inst),
    makeChunk("ibag", ibag),
    makeChunk("imod", Buffer.alloc(10)),
    makeChunk("igen", igen),
    makeChunk("shdr", shdr),
  ]);
  const sdta = makeList("sdta", [makeChunk("smpl", Buffer.alloc(325_000 * 2))]);
  const info = makeList("INFO", []);
  const body = Buffer.concat([Buffer.from("sfbk", "ascii"), info, sdta, pdta]);
  return makeChunk("RIFF", body);
}

function knownMetadata() {
  const samples = Array.from({ length: 291 }, (_, index) => ({
    index,
    name: index === 290 ? "EOS" : "Sample " + index,
    start: 0,
    end: 1,
    loopStart: 0,
    loopEnd: 0,
    sampleRate: 48_000,
    originalPitch: 60,
    pitchCorrection: 0,
    sampleLink: 0,
    sampleType: 1,
  }));
  Object.assign(samples[287], {
    name: "C214 XY-R PD f D#6-L",
    start: 155_978_111,
    end: 156_139_559,
    loopStart: 156_104_304,
    loopEnd: 156_139_551,
    originalPitch: 1,
    sampleLink: 288,
    sampleType: 4,
  });
  Object.assign(samples[288], {
    name: "C214 XY-R PD f D#6-R",
    start: 156_139_605,
    end: 156_301_053,
    loopStart: 156_282_814,
    loopEnd: 156_301_045,
    originalPitch: 1,
    sampleLink: 0,
    sampleType: 1,
  });
  return {
    fileSize: 313_732_108,
    sampleDataCount: 156_500_000,
    shdrOffset: 100,
    samples,
    references: {
      presets: PRESET_NAMES.map((name, program) => ({
        name,
        program,
        bank: 0,
        usesSample287: true,
        usesSample288: true,
      })),
      instrumentIdsBySample: {
        287: [0, 1, 2, 3, 4, 5, 6, 7],
        288: [0, 1, 2, 3, 4, 5, 6, 7],
      },
    },
  };
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fazioli-repair-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("reads the SF2 sample headers and the four presets that use the pair", async () => {
  await withTempDirectory(async (directory) => {
    const input = path.join(directory, "fixture.sf2");
    await writeFile(input, makeFixtureSf2());
    const metadata = await inspectSf2File(input);

    assert.equal(metadata.samples.length, 291);
    assert.deepEqual(
      [metadata.samples[287].name, metadata.samples[287].sampleType, metadata.samples[287].sampleLink],
      ["C214 XY-R PD f D#6-L", 4, 288],
    );
    assert.deepEqual(
      [metadata.samples[288].name, metadata.samples[288].sampleType, metadata.samples[288].sampleLink],
      ["C214 XY-R PD f D#6-R", 1, 0],
    );
    assert.deepEqual(metadata.references.presets.map((preset) => preset.name), PRESET_NAMES);
    assert.ok(metadata.references.presets.every((preset) => preset.usesSample287 && preset.usesSample288));
    assert.deepEqual(metadata.references.instrumentIdsBySample[287], metadata.references.instrumentIdsBySample[288]);
  });
});

test("pins the repair to the named samples, exact headers, reciprocal target, and all four presets", () => {
  const patches = validateFazioliV30Metadata(knownMetadata());
  assert.deepEqual(patches.map(({ sampleIndex, field, before, after }) => ({
    sampleIndex, field, before, after,
  })), [
    { sampleIndex: 288, field: "sampleLink", before: 0, after: 287 },
    { sampleIndex: 288, field: "sampleType", before: 1, after: 2 },
  ]);
  assert.deepEqual(patches.map((patch) => patch.offset), [100 + 288 * 46 + 42, 100 + 288 * 46 + 44]);

  const unexpectedType = knownMetadata();
  unexpectedType.samples[288].sampleType = 3;
  assert.throws(() => validateFazioliV30Metadata(unexpectedType), /unexpected sampleType/);

  const missingPresetReference = knownMetadata();
  missingPresetReference.references.presets[2].usesSample288 = false;
  assert.throws(() => validateFazioliV30Metadata(missingPresetReference), /expected four presets/);
});

test("copies only explicit 16-bit fields and refuses to overwrite an existing output", async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, "source.bin");
    const output = path.join(directory, "copy.repaired.sf2");
    const sourceBytes = Buffer.from([7, 8, 9, 0, 0, 10, 11, 1, 0, 12, 13, 14]);
    await writeFile(source, sourceBytes);
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const report = await copyFileWithPatches(source, output, sourceHash, [
      { offset: 3, before: 0, after: 287, field: "sampleLink" },
      { offset: 7, before: 1, after: 2, field: "sampleType" },
    ]);
    const expected = Buffer.from(sourceBytes);
    expected.writeUInt16LE(287, 3);
    expected.writeUInt16LE(2, 7);
    assert.deepEqual(await readFile(output), expected);
    assert.equal(report.outputSha256, createHash("sha256").update(expected).digest("hex"));

    await writeFile(output, "preserve existing output");
    await assert.rejects(
      copyFileWithPatches(source, output, sourceHash, [
        { offset: 3, before: 0, after: 287, field: "sampleLink" },
      ]),
      (error) => error.code === "EEXIST",
    );
    assert.equal((await readFile(output)).toString(), "preserve existing output");
  });
});

test("removes an incomplete output when a source field no longer matches its manifest", async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, "source.bin");
    const output = path.join(directory, "partial.repaired.sf2");
    const bytes = Buffer.from([0, 0, 1, 0, 2]);
    await writeFile(source, bytes);
    const sourceHash = createHash("sha256").update(bytes).digest("hex");
    await assert.rejects(
      copyFileWithPatches(source, output, sourceHash, [
        { offset: 2, before: 99, after: 287, field: "sampleLink" },
      ]),
      /source field sampleLink changed/,
    );
    await assert.rejects(readFile(output), (error) => error.code === "ENOENT");
  });
});

test("rejects an unpinned SF2 file without creating a repair copy", async () => {
  await withTempDirectory(async (directory) => {
    const input = path.join(directory, "fixture.sf2");
    const output = path.join(directory, "fixture.repaired.sf2");
    await writeFile(input, makeFixtureSf2());
    await assert.rejects(repairFazioliV30Stereo(input, output), /pinned v3.0 file size/);
    await assert.rejects(readFile(output), (error) => error.code === "ENOENT");
  });
});
