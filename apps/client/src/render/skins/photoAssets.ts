import { Assets, Texture } from "pixi.js";
import { releaseAssetUrl } from "../../pwa/urls";

export const PHOTO_RIG_RIGHT_URLS = {
  forearm: releaseAssetUrl("textures/photo-rig/forearm.png").href,
  dorsum: releaseAssetUrl("textures/photo-rig/dorsum.png").href,
  1: releaseAssetUrl("textures/photo-rig/finger_1.png").href,
  2: releaseAssetUrl("textures/photo-rig/finger_2.png").href,
  3: releaseAssetUrl("textures/photo-rig/finger_3.png").href,
  4: releaseAssetUrl("textures/photo-rig/finger_4.png").href,
  5: releaseAssetUrl("textures/photo-rig/finger_5.png").href,
} as const;

export const PHOTO_RIG_LEFT_URLS = {
  forearm: releaseAssetUrl("textures/photo-rig/forearm_left.png").href,
  dorsum: releaseAssetUrl("textures/photo-rig/dorsum_left.png").href,
  1: releaseAssetUrl("textures/photo-rig/finger_1_left.png").href,
  2: releaseAssetUrl("textures/photo-rig/finger_2_left.png").href,
  3: releaseAssetUrl("textures/photo-rig/finger_3_left.png").href,
  4: releaseAssetUrl("textures/photo-rig/finger_4_left.png").href,
  5: releaseAssetUrl("textures/photo-rig/finger_5_left.png").href,
} as const;

export const PHOTO_MESH_URLS = {
  right: releaseAssetUrl("textures/photo-hand-right.png").href,
  left: releaseAssetUrl("textures/photo-hand-left.png").href,
} as const;

export const ALL_PHOTO_URLS: string[] = [
  PHOTO_RIG_RIGHT_URLS.forearm,
  PHOTO_RIG_RIGHT_URLS.dorsum,
  PHOTO_RIG_RIGHT_URLS[1],
  PHOTO_RIG_RIGHT_URLS[2],
  PHOTO_RIG_RIGHT_URLS[3],
  PHOTO_RIG_RIGHT_URLS[4],
  PHOTO_RIG_RIGHT_URLS[5],
  PHOTO_RIG_LEFT_URLS.forearm,
  PHOTO_RIG_LEFT_URLS.dorsum,
  PHOTO_RIG_LEFT_URLS[1],
  PHOTO_RIG_LEFT_URLS[2],
  PHOTO_RIG_LEFT_URLS[3],
  PHOTO_RIG_LEFT_URLS[4],
  PHOTO_RIG_LEFT_URLS[5],
  PHOTO_MESH_URLS.right,
  PHOTO_MESH_URLS.left,
];

type LoadedListener = () => void;
const listeners = new Set<LoadedListener>();

let preloadPromise: Promise<boolean> | null = null;
let isLoadedFlag = false;

/**
 * Register a listener to be notified when photo textures finish loading.
 */
export function onPhotoAssetsLoaded(listener: LoadedListener): () => void {
  listeners.add(listener);
  if (isLoadedFlag) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Preloads all photographic textures asynchronously via PixiJS v8 Assets.load.
 */
export async function preloadAllPhotoAssets(): Promise<boolean> {
  if (isLoadedFlag) return true;
  if (preloadPromise) return preloadPromise;

  preloadPromise = (async () => {
    try {
      if (typeof window === "undefined" || !Assets || typeof Assets.load !== "function") {
        return false;
      }
      await Assets.load(ALL_PHOTO_URLS);
      isLoadedFlag = true;
      for (const cb of [...listeners]) {
        try {
          cb();
        } catch {
          // ignore
        }
      }
      return true;
    } catch (err) {
      console.warn("Photo assets load warning (vector realistic fallback active):", err);
      return false;
    }
  })();

  return preloadPromise;
}

/**
 * Safely inspect and retrieve a loaded Texture from PixiJS Assets cache.
 * Returns null if not cached or texture dimensions are 0 (not yet loaded).
 */
export function getLoadedTexture(url: string): Texture | null {
  try {
    if (!Assets || !Assets.cache || !Assets.cache.has(url)) return null;
    const tex = Assets.get<Texture>(url);
    if (!tex || !tex.source) return null;
    if (tex.source.width <= 0 || tex.source.height <= 0) return null;
    return tex;
  } catch {
    return null;
  }
}

/**
 * Checks whether all parts of the photo rig for a specific hand are loaded and valid.
 */
export function isPhotoRigReady(hand: "left" | "right"): boolean {
  const map = hand === "left" ? PHOTO_RIG_LEFT_URLS : PHOTO_RIG_RIGHT_URLS;
  if (!getLoadedTexture(map.forearm)) return false;
  if (!getLoadedTexture(map.dorsum)) return false;
  for (let f = 1; f <= 5; f++) {
    const key = f as keyof typeof map;
    if (!getLoadedTexture(map[key])) return false;
  }
  return true;
}

/**
 * Checks whether the photo mesh texture for a specific hand is loaded and valid.
 */
export function isPhotoMeshReady(hand: "left" | "right"): boolean {
  const url = hand === "left" ? PHOTO_MESH_URLS.left : PHOTO_MESH_URLS.right;
  return getLoadedTexture(url) !== null;
}

// Auto-trigger preload in browser environment
if (typeof window !== "undefined") {
  preloadAllPhotoAssets().catch(() => {});
}
