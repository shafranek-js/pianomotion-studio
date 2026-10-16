import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_SOUNDFONT_ASSET_PATH,
  BUILTIN_SOUNDFONT_BYTE_LENGTH,
  BUILTIN_SOUNDFONT_ID,
  BUILTIN_SOUNDFONT_NAME,
  loadBuiltinSoundFont,
} from "./builtinSoundfont.ts";
import { computeSha256Hex } from "./soundfontAssetStore.ts";
import { releaseAssetUrl } from "../../pwa/urls.ts";

vi.mock("./soundfontAssetStore.ts", () => ({ computeSha256Hex: vi.fn() }));
vi.mock("../../pwa/urls.ts", () => ({ releaseAssetUrl: vi.fn((value: string) => new URL(value, "https://example.test/app/")) }));

const digestMock = vi.mocked(computeSha256Hex);
const assetUrlMock = vi.mocked(releaseAssetUrl);

function responseWithBlob(data: Blob, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    blob: vi.fn().mockResolvedValue(data),
  } as unknown as Response;
}

function sizedBlob(byteLength: number): Blob {
  const data = new Blob(["small test payload"]);
  Object.defineProperty(data, "size", { value: byteLength });
  return data;
}

describe("built-in MuseScore General SoundFont loader", () => {
  beforeEach(() => {
    digestMock.mockReset();
    digestMock.mockResolvedValue(BUILTIN_SOUNDFONT_ID);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches the immutable release asset and returns the verified Blob identity", async () => {
    const data = sizedBlob(BUILTIN_SOUNDFONT_BYTE_LENGTH);
    vi.mocked(fetch).mockResolvedValue(responseWithBlob(data));

    const result = await loadBuiltinSoundFont();

    expect(assetUrlMock).toHaveBeenCalledWith(BUILTIN_SOUNDFONT_ASSET_PATH);
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), { signal: undefined });
    expect(digestMock).toHaveBeenCalledWith(data, { signal: undefined });
    expect(result).toEqual({
      id: BUILTIN_SOUNDFONT_ID,
      name: BUILTIN_SOUNDFONT_NAME,
      data,
      byteLength: BUILTIN_SOUNDFONT_BYTE_LENGTH,
    });
  });

  it("rejects a response whose byte length differs from the descriptor", async () => {
    vi.mocked(fetch).mockResolvedValue(responseWithBlob(new Blob(["wrong size"])));

    await expect(loadBuiltinSoundFont()).rejects.toThrow(/size does not match/i);
    expect(digestMock).not.toHaveBeenCalled();
  });

  it("rejects content whose SHA-256 differs from the descriptor", async () => {
    vi.mocked(fetch).mockResolvedValue(responseWithBlob(sizedBlob(BUILTIN_SOUNDFONT_BYTE_LENGTH)));
    digestMock.mockResolvedValue("0".repeat(64));

    await expect(loadBuiltinSoundFont()).rejects.toThrow(/SHA-256/i);
  });

  it("preserves aborts and does not start a request for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(loadBuiltinSoundFont({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a release response error", async () => {
    vi.mocked(fetch).mockResolvedValue(responseWithBlob(new Blob(), 503));

    await expect(loadBuiltinSoundFont()).rejects.toThrow(/HTTP 503/i);
  });
});
