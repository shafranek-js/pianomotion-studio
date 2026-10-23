/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "*prepare-builtin-melodies.mjs" {
  export function assertNoCaseCollisions(...args: any[]): void;
  export function prepareBuiltinMelodies(...args: any[]): Promise<{
    manifest: { entries: Array<{
      id: string;
      title: string;
      fileName: string;
      assetPath: string;
      sha256: string;
      byteLength: number;
      difficultyScore: number;
      difficultyTier: string;
    }> };
    melodyCount: number;
    uniqueAssetCount: number;
  }>;
}

declare module "*prepare-builtin-soundfont.mjs" {
  export function prepareBuiltinSoundfont(...args: any[]): Promise<any>;
}

declare module "*release-assets.mjs" {
  export function assertReleaseAssets(publicRoot: string): Promise<void>;
}

declare module "*release-inventory.mjs" {
  export const PINNED_ABI_VERSION: string;
  export const PINNED_CORE_MODULES: readonly string[];
  export const PINNED_PLATFORM: string;
  export const PINNED_PYODIDE_FILES: readonly string[];
  export const PINNED_PYODIDE_VERSION: string;
  export const PINNED_PYTHON_VERSION: string;
  export const PINNED_PYTHON_WHEELS: readonly string[];
}

declare module "*verify-release-dist.mjs" {
  export function verifyReleaseDist(distRoot: string): Promise<any>;
}
