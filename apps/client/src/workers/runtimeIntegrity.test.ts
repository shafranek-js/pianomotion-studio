import { describe, expect, it, vi } from "vitest";
import { RuntimeIntegrityError, verifyRuntimeAssets } from "./runtimeIntegrity";

const hash = "a".repeat(64);
const base = new URL("https://example.test/releases/build/pyodide/");

describe("SEC-3 Pyodide runtime integrity", () => {
  it("verifies every declared file and returns the bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const read = vi.fn(async () => bytes);
    const digest = vi.fn(async () => hash);

    const verified = await verifyRuntimeAssets([{ path: "pyodide/pyodide.mjs", sha256: hash }], base, read, digest);

    expect(verified.get("pyodide/pyodide.mjs")).toBe(bytes);
    expect(read).toHaveBeenCalledWith(new URL("https://example.test/releases/build/pyodide/pyodide.mjs"));
  });

  it("rejects corrupted runtime bytes and unsafe manifest entries", async () => {
    await expect(verifyRuntimeAssets(
      [{ path: "pyodide/pyodide.mjs", sha256: hash }],
      base,
      async () => new Uint8Array([0]).buffer,
      async () => "b".repeat(64),
    )).rejects.toMatchObject<Partial<RuntimeIntegrityError>>({ code: "RUNTIME_CHECKSUM_MISMATCH" });

    await expect(verifyRuntimeAssets(
      [{ path: "pyodide/../escape.mjs", sha256: hash }],
      base,
      async () => new Uint8Array([0]).buffer,
      async () => hash,
    )).rejects.toMatchObject<Partial<RuntimeIntegrityError>>({ code: "RUNTIME_MANIFEST_MISMATCH" });
  });
});
