export type RuntimeAsset = { path: string; sha256: string };

export class RuntimeIntegrityError extends Error {
  constructor(
    readonly code: "RUNTIME_MANIFEST_MISMATCH" | "RUNTIME_CHECKSUM_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeIntegrityError";
  }
}

export type RuntimeAssetReader = (url: URL) => Promise<ArrayBuffer>;
export type RuntimeAssetHasher = (bytes: ArrayBuffer) => Promise<string>;

/**
 * Fetch every Pyodide runtime file and verify its declared SHA-256 before any
 * of it is loaded. The returned bytes are reused for the JS module.
 */
export async function verifyRuntimeAssets(
  files: RuntimeAsset[],
  runtimeBaseUrl: URL,
  readBytes: RuntimeAssetReader,
  hash: RuntimeAssetHasher,
): Promise<Map<string, ArrayBuffer>> {
  const releaseRoot = new URL("../", runtimeBaseUrl);
  const verified = new Map<string, ArrayBuffer>();
  for (const file of files) {
    if (!/^pyodide\/[A-Za-z0-9._/-]+$/.test(file.path) || file.path.includes("..") || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new RuntimeIntegrityError(
        "RUNTIME_MANIFEST_MISMATCH",
        "The Pyodide runtime manifest contains an unsafe path or hash.",
      );
    }
    const bytes = await readBytes(new URL(file.path, releaseRoot));
    if (await hash(bytes) !== file.sha256) {
      throw new RuntimeIntegrityError(
        "RUNTIME_CHECKSUM_MISMATCH",
        `SHA-256 verification failed for ${file.path}.`,
      );
    }
    verified.set(file.path, bytes);
  }
  return verified;
}
