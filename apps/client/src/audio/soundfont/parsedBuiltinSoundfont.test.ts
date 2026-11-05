import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SOUNDFONT_ID, loadBuiltinSoundFont } from "./builtinSoundfont.ts";
import { parseSf2Async } from "./sf2Parser.ts";
import type { Sf2SoundFont } from "./types.ts";

vi.mock("./builtinSoundfont.ts", () => ({
  BUILTIN_SOUNDFONT_ID: "included-sha256",
  loadBuiltinSoundFont: vi.fn(),
}));
vi.mock("./sf2Parser.ts", () => ({ parseSf2Async: vi.fn() }));

const asset = { id: BUILTIN_SOUNDFONT_ID, name: "Included", data: new Blob(["bank"]), byteLength: 4 };
function soundFont(): Sf2SoundFont {
  return { sampleSource: { blob: asset.data, sampleDataOffset: 0, sampleCount: 1 } } as Sf2SoundFont;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("shared parsed included SoundFont", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(loadBuiltinSoundFont).mockReset().mockResolvedValue(asset);
    vi.mocked(parseSf2Async).mockReset().mockResolvedValue(soundFont());
  });

  it("shares a pending fetch and parse, then reuses the same immutable sample identity", async () => {
    const loading = deferred<typeof asset>();
    vi.mocked(loadBuiltinSoundFont).mockReturnValue(loading.promise);
    const { loadParsedBuiltinSoundFont } = await import("./parsedBuiltinSoundfont.ts");
    const first = loadParsedBuiltinSoundFont();
    const second = loadParsedBuiltinSoundFont();
    loading.resolve(asset);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.soundFont.sampleSource?.assetId).toBe(BUILTIN_SOUNDFONT_ID);
    expect(await loadParsedBuiltinSoundFont()).toBe(a);
    expect(loadBuiltinSoundFont).toHaveBeenCalledTimes(1);
    expect(parseSf2Async).toHaveBeenCalledTimes(1);
  });

  it("settles a cancelled consumer promptly without cancelling another output's shared load", async () => {
    const parsing = deferred<Sf2SoundFont>();
    vi.mocked(parseSf2Async).mockReturnValue(parsing.promise);
    const { loadParsedBuiltinSoundFont } = await import("./parsedBuiltinSoundfont.ts");
    const cancelled = new AbortController();
    const first = loadParsedBuiltinSoundFont(cancelled.signal);
    const second = loadParsedBuiltinSoundFont();
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    cancelled.abort();
    await rejected;
    parsing.resolve(soundFont());
    const loaded = await second;
    expect(await loadParsedBuiltinSoundFont()).toBe(loaded);
    expect(vi.mocked(loadBuiltinSoundFont).mock.calls[0]?.[0]?.signal?.aborted).toBe(false);
    expect(loadBuiltinSoundFont).toHaveBeenCalledTimes(1);
  });

  it("cancels an unneeded load, retries immediately, and rejects late stale parse results", async () => {
    const parsing = deferred<Sf2SoundFont>();
    const stale = soundFont();
    const fresh = soundFont();
    vi.mocked(parseSf2Async).mockReturnValueOnce(parsing.promise).mockResolvedValueOnce(fresh);
    const { loadParsedBuiltinSoundFont } = await import("./parsedBuiltinSoundfont.ts");
    const controller = new AbortController();
    const old = loadParsedBuiltinSoundFont(controller.signal);
    await vi.waitFor(() => expect(parseSf2Async).toHaveBeenCalledTimes(1));
    const rejection = expect(old).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    const retry = await loadParsedBuiltinSoundFont();
    parsing.resolve(stale);
    await Promise.resolve();
    expect((await loadParsedBuiltinSoundFont()).soundFont).toBe(fresh);
    expect(retry.soundFont).toBe(fresh);
    expect(loadBuiltinSoundFont).toHaveBeenCalledTimes(2);
  });

  it.each(["fetch", "parse"])("does not cache a failed %s and permits a later usable bank", async stage => {
    if (stage === "fetch") vi.mocked(loadBuiltinSoundFont).mockRejectedValueOnce(new Error("HTTP 503"));
    else vi.mocked(parseSf2Async).mockRejectedValueOnce(new Error("Invalid bank"));
    const { loadParsedBuiltinSoundFont } = await import("./parsedBuiltinSoundfont.ts");
    await expect(loadParsedBuiltinSoundFont()).rejects.toThrow(stage === "fetch" ? "HTTP 503" : "Invalid bank");
    await expect(loadParsedBuiltinSoundFont()).resolves.toMatchObject({ asset });
  });

  it("does not start a load for an already cancelled output", async () => {
    const { loadParsedBuiltinSoundFont } = await import("./parsedBuiltinSoundfont.ts");
    const controller = new AbortController();
    controller.abort();
    await expect(loadParsedBuiltinSoundFont(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(loadBuiltinSoundFont).not.toHaveBeenCalled();
  });
});
