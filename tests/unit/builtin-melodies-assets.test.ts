import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBuiltinMelodies, loadBuiltinMelodyBytes, type BuiltinMelodyEntry } from "../../apps/client/src/melodies/catalog";
import { assertNoCaseCollisions, prepareBuiltinMelodies } from "../../tools/prepare-builtin-melodies.mjs";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pianomotion-builtin-midi-"));
  temporaryDirectories.push(directory);
  return directory;
}

function midiBytes(marker = 0): Buffer {
  return Buffer.from([
    0x4d, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06, // six-byte header
    0x00, 0x00, // format 0
    0x00, 0x01, // one track
    0x00, 0x60, // 96 ticks per quarter note
    0x4d, 0x54, 0x72, 0x6b, // MTrk
    0x00, 0x00, 0x00, 0x04, // four-byte track
    0x00, 0xff, 0x2f, marker, // end-of-track event payload
  ]);
}

async function prepareFixture(files: Array<[string, Buffer]>): Promise<{ sourceDir: string; destinationDir: string }> {
  const root = await makeTemporaryDirectory();
  const sourceDir = path.join(root, "source");
  const destinationDir = path.join(root, "public", "builtin-melodies");
  await mkdir(sourceDir, { recursive: true });
  for (const [relativePath, bytes] of files) {
    const absolutePath = path.join(sourceDir, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
  }
  return { sourceDir, destinationDir };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("built-in melody assets", () => {
  it("copies exact MIDI bytes to content-addressed paths and produces stable, ordered metadata", async () => {
    const sharedBytes = midiBytes();
    const laterBytes = midiBytes(1);
    const fixture = await prepareFixture([
      ["nested/Second Song.midi", laterBytes],
      ["First Song.mid", sharedBytes],
      ["Alias of First.mid", sharedBytes],
      ["ignored.txt", Buffer.from("not a MIDI source")],
    ]);

    const firstRun = await prepareBuiltinMelodies(fixture);
    const manifestBytes = await readFile(path.join(fixture.destinationDir, "manifest.json"));
    const generatedFiles = [
      path.join(fixture.destinationDir, "manifest.json"),
      ...firstRun.manifest.entries.map((entry) => path.join(fixture.destinationDir, entry.assetPath)),
    ];
    const fixedTimestamp = new Date("2001-02-03T04:05:06.000Z");
    for (const filePath of generatedFiles) await utimes(filePath, fixedTimestamp, fixedTimestamp);
    const timestampsBefore = await Promise.all(generatedFiles.map(async (filePath) => (await stat(filePath)).mtimeMs));

    const secondRun = await prepareBuiltinMelodies(fixture);
    const timestampsAfter = await Promise.all(generatedFiles.map(async (filePath) => (await stat(filePath)).mtimeMs));
    expect(await readFile(path.join(fixture.destinationDir, "manifest.json"))).toEqual(manifestBytes);
    expect(timestampsAfter).toEqual(timestampsBefore);
    expect(secondRun.manifest).toEqual(firstRun.manifest);
    expect(firstRun.melodyCount).toBe(3);
    expect(firstRun.uniqueAssetCount).toBe(2);
    expect(firstRun.manifest.entries.map((entry) => entry.title)).toEqual([
      "Alias of First",
      "First Song",
      "Second Song",
    ]);

    const [alias, first, second] = firstRun.manifest.entries;
    expect(alias.id).toBe(sha256(Buffer.from("Alias of First.mid")));
    expect(first.id).toBe(sha256(Buffer.from("First Song.mid")));
    expect(alias.id).not.toBe(first.id);
    expect(alias.assetPath).toBe(first.assetPath);
    expect(alias.sha256).toBe(sha256(sharedBytes));
    expect(second.assetPath).toMatch(/^files\/[a-f0-9]{64}\.mid$/);

    for (const entry of firstRun.manifest.entries) {
      const copied = await readFile(path.join(fixture.destinationDir, entry.assetPath));
      const source = await readFile(path.join(fixture.sourceDir, ...entry.fileName.split("/")));
      expect(copied).toEqual(source);
      expect(copied.byteLength).toBe(entry.byteLength);
      expect(sha256(copied)).toBe(entry.sha256);
    }
    expect((await readdir(path.join(fixture.destinationDir, "files"))).sort()).toHaveLength(2);
  });

  it("rejects missing sources, malformed MIDI, and source paths that differ only by case", async () => {
    const missingRoot = await makeTemporaryDirectory();
    await expect(prepareBuiltinMelodies({ sourceDir: path.join(missingRoot, "absent") }))
      .rejects.toThrow(/source directory was not found/i);

    const corrupt = await prepareFixture([["Broken.mid", Buffer.from("not MIDI")]]);
    await expect(prepareBuiltinMelodies(corrupt)).rejects.toThrow(/structurally valid MIDI/i);

    expect(() => assertNoCaseCollisions(["Song.mid", "song.mid"])).toThrow(/differ only by case/i);
  });

  it("uses release asset URLs, rejects traversal metadata, and verifies downloaded bytes", async () => {
    const fixture = await prepareFixture([["A Tune.mid", midiBytes()]]);
    const { manifest } = await prepareBuiltinMelodies(fixture);
    const entry = manifest.entries[0] as BuiltinMelodyEntry;
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } }));

    const entries = await loadBuiltinMelodies();
    expect(entries).toEqual([entry]);
    expect(fetchMock.mock.calls[0][0]).toBeInstanceOf(URL);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/builtin-melodies\/manifest\.json$/);

    const traversalManifest = structuredClone(manifest);
    traversalManifest.entries[0].assetPath = `files/../${entry.sha256}.mid`;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(traversalManifest)));
    await expect(loadBuiltinMelodies()).rejects.toThrow(/invalid entry metadata/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const forgedEntry = { ...entry, assetPath: "files/../../outside.mid" } as BuiltinMelodyEntry;
    await expect(loadBuiltinMelodyBytes(forgedEntry)).rejects.toThrow(/invalid entry metadata/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const changedBytes = midiBytes();
    changedBytes[changedBytes.length - 1] ^= 0x01;
    fetchMock.mockResolvedValueOnce(new Response(changedBytes));
    await expect(loadBuiltinMelodyBytes(entry)).rejects.toThrow(/SHA-256 checksum does not match/i);
    const assetUrl = fetchMock.mock.calls[2][0];
    expect(String(assetUrl)).toMatch(new RegExp(`/builtin-melodies/${entry.assetPath.replaceAll("/", "\\/")}$`));
  });
});
