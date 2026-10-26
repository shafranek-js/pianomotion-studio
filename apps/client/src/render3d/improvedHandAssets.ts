import * as THREE from "three";
import { releaseAssetUrl } from "../pwa/urls";
import type { ImprovedHandLod } from "./improvedHandRuntime";

export type ImprovedHandSide = "left" | "right";
export type ImprovedHandTextureSetId = "high" | "low";

export interface ImprovedHandTextureSetManifest {
  baseColor: string;
  normal: string;
  roughness: string;
  flipY: false;
  baseColorColorSpace: "srgb";
  normalColorSpace: "linear";
  roughnessColorSpace: "linear";
}

export interface ImprovedHandLodManifest {
  level: ImprovedHandLod;
  url: string;
  triangles: number;
  vertices: number;
  textureSet: ImprovedHandTextureSetId;
  boundaryVertices: number[];
  boundaryLoops: number[][];
  landmarks?: Record<string, [number, number, number]>;
}

export interface ImprovedHandBoneFrame {
  forward: [number, number, number];
  dorsal: [number, number, number];
  hinge: [number, number, number];
}

export interface ImprovedHandManifestExtras {
  restDorsalAxis: [number, number, number];
  boneFrames: Record<ImprovedHandSide, Record<string, ImprovedHandBoneFrame>>;
  wristFrameProfile?: "palm-mcp-v1";
}

export interface ImprovedHandManifest {
  schemaVersion: 1;
  modelId: "anatomical-improved";
  source: { uri: string; sha256: string; vertices: number; triangles: number };
  coordinateFrame: {
    unit: "meters";
    handedness: "right";
    boneForwardAxis: "-Z";
    normalTextureFlipY: false;
  };
  jointNames: string[];
  extras: ImprovedHandManifestExtras;
  textures: Record<ImprovedHandTextureSetId, ImprovedHandTextureSetManifest>;
  hands: Record<ImprovedHandSide, { lods: ImprovedHandLodManifest[] }>;
}

export interface ImprovedHandAsset {
  manifest: ImprovedHandManifest;
  manifestUrl: URL;
  hand: ImprovedHandSide;
  lod: ImprovedHandLodManifest;
  buffer: ArrayBuffer;
  textureSet: ImprovedHandTextureSetManifest;
}

export interface ImprovedHandAssetCacheStats {
  count: number;
  retainedGlbBytes: number;
}

export interface ImprovedHandTextureCacheStats {
  count: number;
  estimatedBaseBytes: number;
}

export const IMPROVED_HAND_JOINT_NAMES = [
  "pinky-finger-tip",
  "pinky-finger-phalanx-distal",
  "pinky-finger-phalanx-intermediate",
  "pinky-finger-phalanx-proximal",
  "pinky-finger-metacarpal",
  "ring-finger-tip",
  "ring-finger-phalanx-distal",
  "ring-finger-phalanx-intermediate",
  "ring-finger-phalanx-proximal",
  "ring-finger-metacarpal",
  "middle-finger-tip",
  "middle-finger-phalanx-distal",
  "middle-finger-phalanx-intermediate",
  "middle-finger-phalanx-proximal",
  "middle-finger-metacarpal",
  "index-finger-tip",
  "index-finger-phalanx-distal",
  "index-finger-phalanx-intermediate",
  "index-finger-phalanx-proximal",
  "index-finger-metacarpal",
  "thumb-tip",
  "thumb-phalanx-distal",
  "thumb-phalanx-proximal",
  "thumb-metacarpal",
  "wrist",
] as const;

const MANIFEST_PATH = "models/hands/improved/manifest.json";
const MANIFEST_URL = releaseAssetUrl(MANIFEST_PATH);

function resolveModelRelativeUrl(manifestUrl: URL, path: string): URL {
  if (!path.trim() || path.startsWith("/") || path.startsWith("\\") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error("Improved hand asset paths must be relative to the model manifest.");
  }
  const url = new URL(path, manifestUrl);
  const base = new URL(".", manifestUrl);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error("Improved hand asset URL escapes its model directory.");
  }
  return url;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isUnitAxis(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 &&
    value.every((component) => typeof component === "number" && Number.isFinite(component)) &&
    Math.abs(Math.hypot(value[0] as number, value[1] as number, value[2] as number) - 1) <= 0.001;
}

function validateTextureSet(value: unknown, label: string): asserts value is ImprovedHandTextureSetManifest {
  if (!isRecord(value)) throw new Error(`Improved hand manifest has no ${label} texture set.`);
  for (const key of ["baseColor", "normal", "roughness"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) {
      throw new Error(`Improved hand ${label} texture set is missing ${key}.`);
    }
  }
  if (value.flipY !== false || value.baseColorColorSpace !== "srgb" ||
      value.normalColorSpace !== "linear" || value.roughnessColorSpace !== "linear") {
    throw new Error(`Improved hand ${label} texture color-space metadata is unsupported.`);
  }
}

export function validateImprovedHandManifest(value: unknown): ImprovedHandManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.modelId !== "anatomical-improved") {
    throw new Error("Improved hand manifest has an unsupported schema or model ID.");
  }
  if (!isRecord(value.source) || typeof value.source.uri !== "string" ||
      /[\\/:]/.test(value.source.uri) || !/^[a-f0-9]{64}$/i.test(String(value.source.sha256)) ||
      !isIntegerInRange(value.source.vertices, 1, 10_000_000) ||
      !isIntegerInRange(value.source.triangles, 1, 20_000_000)) {
    throw new Error("Improved hand manifest source metadata is invalid.");
  }
  if (!isRecord(value.coordinateFrame) || value.coordinateFrame.unit !== "meters" ||
      value.coordinateFrame.handedness !== "right" || value.coordinateFrame.boneForwardAxis !== "-Z" ||
      value.coordinateFrame.normalTextureFlipY !== false) {
    throw new Error("Improved hand manifest coordinate frame is unsupported.");
  }
  if (!Array.isArray(value.jointNames) || value.jointNames.length !== IMPROVED_HAND_JOINT_NAMES.length ||
      value.jointNames.some((name, index) => name !== IMPROVED_HAND_JOINT_NAMES[index])) {
    throw new Error("Improved hand manifest joint order does not match the 25-bone runtime contract.");
  }
  if (!isRecord(value.extras) || !isUnitAxis(value.extras.restDorsalAxis) ||
      !isRecord(value.extras.boneFrames)) {
    throw new Error("Improved hand manifest has no validated anatomical rest-frame metadata.");
  }
  if (value.extras.wristFrameProfile !== undefined && value.extras.wristFrameProfile !== "palm-mcp-v1") {
    throw new Error("Improved hand manifest has an unsupported wrist frame profile.");
  }
  for (const hand of ["left", "right"] as const) {
    const handFrames = value.extras.boneFrames[hand];
    const [restX, restY, restZ] = value.extras.restDorsalAxis as [number, number, number];
    // The right-hand mesh is mirrored across X from the canonical source rest
    // fit; its independent dorsal axis must be reflected by the same transform.
    const sideDorsalAxis = hand === "right" ? [-restX, restY, restZ] : [restX, restY, restZ];
    if (!isRecord(handFrames) || Object.keys(handFrames).length !== IMPROVED_HAND_JOINT_NAMES.length) {
      throw new Error(`Improved hand manifest has no complete ${hand} anatomical bone-frame metadata.`);
    }
    for (const name of IMPROVED_HAND_JOINT_NAMES) {
      const frame = handFrames[name];
      if (!isRecord(frame) || !isUnitAxis(frame.forward) || !isUnitAxis(frame.dorsal) || !isUnitAxis(frame.hinge)) {
        throw new Error(`Improved hand manifest has an invalid ${hand} bone frame for ${name}.`);
      }
      const [fx, fy, fz] = frame.forward;
      const [dx, dy, dz] = frame.dorsal;
      const [hx, hy, hz] = frame.hinge;
      const forwardDotDorsal = fx * dx + fy * dy + fz * dz;
      const forwardDotHinge = fx * hx + fy * hy + fz * hz;
      const dorsalDotHinge = dx * hx + dy * hy + dz * hz;
      const rightHandedness = (hy * dz - hz * dy) * -fx +
        (hz * dx - hx * dz) * -fy + (hx * dy - hy * dx) * -fz;
      const dorsalAlignment = dx * sideDorsalAxis[0]! + dy * sideDorsalAxis[1]! + dz * sideDorsalAxis[2]!;
      if (Math.abs(forwardDotDorsal) > 0.001 || Math.abs(forwardDotHinge) > 0.001 ||
          Math.abs(dorsalDotHinge) > 0.001 || rightHandedness < 0.999 || dorsalAlignment < 0.65) {
        throw new Error(`Improved hand manifest ${hand} bone frame for ${name} is rolled or not right-handed.`);
      }
    }
  }
  if (!isRecord(value.textures)) throw new Error("Improved hand manifest has no texture sets.");
  validateTextureSet(value.textures.high, "high");
  validateTextureSet(value.textures.low, "low");

  if (!isRecord(value.hands)) throw new Error("Improved hand manifest has no hand entries.");
  for (const hand of ["left", "right"] as const) {
    const handEntry = value.hands[hand];
    if (!isRecord(handEntry) || !Array.isArray(handEntry.lods) || handEntry.lods.length !== 3) {
      throw new Error(`Improved hand manifest has no complete ${hand} LOD set.`);
    }
    for (let index = 0; index < 3; index++) {
      const lod = handEntry.lods[index];
      const expectedSet = index < 2 ? "high" : "low";
      if (!isRecord(lod) || lod.level !== index || typeof lod.url !== "string" ||
          !lod.url.trim() || !isIntegerInRange(lod.triangles, 1, 1_000_000) ||
          !isIntegerInRange(lod.vertices, 1, 1_000_000) || lod.textureSet !== expectedSet) {
        throw new Error(`Improved hand ${hand} LOD ${index} metadata is invalid.`);
      }
      if (lod.url.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(lod.url)) {
        throw new Error(`Improved hand ${hand} LOD ${index} URL must stay inside the model directory.`);
      }
      const vertexCount = lod.vertices as number;
      if (!Array.isArray(lod.boundaryVertices) || !Array.isArray(lod.boundaryLoops) ||
          lod.boundaryLoops.length !== 1 || !Array.isArray(lod.boundaryLoops[0])) {
        throw new Error(`Improved hand ${hand} LOD ${index} has no ordered wrist boundary loop.`);
      }
      const loop = lod.boundaryLoops[0] as unknown[];
      const boundary = lod.boundaryVertices as unknown[];
      if (loop.length < 3 || loop.some((vertex) => !isIntegerInRange(vertex, 0, vertexCount - 1)) ||
          new Set(loop).size !== loop.length || boundary.length !== loop.length ||
          boundary.some((vertex) => !isIntegerInRange(vertex, 0, vertexCount - 1)) ||
          new Set(boundary).size !== boundary.length ||
          loop.some((vertex) => !boundary.includes(vertex))) {
        throw new Error(`Improved hand ${hand} LOD ${index} wrist boundary indices are invalid.`);
      }
      if (lod.landmarks !== undefined) {
        if (!isRecord(lod.landmarks) || Object.values(lod.landmarks).some((point) =>
          !Array.isArray(point) || point.length !== 3 || point.some((component) =>
            typeof component !== "number" || !Number.isFinite(component)))) {
          throw new Error(`Improved hand ${hand} LOD ${index} landmarks are invalid.`);
        }
      }
    }
  }
  for (const textureSet of [value.textures.high, value.textures.low]) {
    const textures = textureSet as ImprovedHandTextureSetManifest;
    for (const path of [textures.baseColor, textures.normal, textures.roughness]) {
      if (path.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
        throw new Error("Improved hand texture URLs must stay inside the model directory.");
      }
    }
  }
  return value as unknown as ImprovedHandManifest;
}

function validateManifestAssetUrls(manifest: ImprovedHandManifest, manifestUrl: URL): void {
  // Validate every path before the first asset fetch. This prevents one bad
  // entry from making a later switch fetch outside the packaged model folder.
  for (const hand of ["left", "right"] as const) {
    for (const lod of manifest.hands[hand].lods) resolveModelRelativeUrl(manifestUrl, lod.url);
  }
  for (const textureSet of [manifest.textures.high, manifest.textures.low]) {
    resolveModelRelativeUrl(manifestUrl, textureSet.baseColor);
    resolveModelRelativeUrl(manifestUrl, textureSet.normal);
    resolveModelRelativeUrl(manifestUrl, textureSet.roughness);
  }
}

/** Fetches only requested LODs and keeps successful immutable build assets cached. */
export class ImprovedHandAssetLoader {
  private manifestPromise: Promise<ImprovedHandManifest> | null = null;
  private readonly buffers = new Map<string, ArrayBuffer>();
  private readonly bufferPromises = new Map<string, Promise<ArrayBuffer>>();
  private generation = 0;

  public constructor(
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
    private readonly manifestUrl: URL = MANIFEST_URL,
  ) {}

  public async load(hand: ImprovedHandSide, level: ImprovedHandLod): Promise<ImprovedHandAsset> {
    const generation = this.generation;
    const manifest = await this.getManifest();
    if (generation !== this.generation) throw new Error("Improved hand asset request was superseded.");
    const lod = manifest.hands[hand].lods[level];
    const url = resolveModelRelativeUrl(this.manifestUrl, lod.url);
    const buffer = await this.getBuffer(url, generation);
    if (generation !== this.generation) throw new Error("Improved hand asset request was superseded.");
    return { manifest, manifestUrl: this.manifestUrl, hand, lod, buffer, textureSet: manifest.textures[lod.textureSet] };
  }

  public async getManifest(): Promise<ImprovedHandManifest> {
    if (!this.manifestPromise) {
      const generation = this.generation;
      const pending = this.fetcher(this.manifestUrl).then(async (response) => {
        if (!response.ok) throw new Error(`Improved hand manifest request failed (${response.status}).`);
        const manifest = validateImprovedHandManifest(await response.json());
        validateManifestAssetUrls(manifest, this.manifestUrl);
        if (generation !== this.generation) throw new Error("Improved hand manifest request was superseded.");
        return manifest;
      }).catch((error: unknown) => {
        if (generation === this.generation) this.manifestPromise = null;
        throw error;
      });
      this.manifestPromise = pending;
    }
    return this.manifestPromise;
  }

  public getCacheStats(): ImprovedHandAssetCacheStats {
    let retainedGlbBytes = 0;
    for (const buffer of this.buffers.values()) retainedGlbBytes += buffer.byteLength;
    return { count: this.buffers.size, retainedGlbBytes };
  }

  public clear(): void {
    this.generation += 1;
    this.buffers.clear();
    this.bufferPromises.clear();
    this.manifestPromise = null;
  }

  private getBuffer(url: URL, generation: number): Promise<ArrayBuffer> {
    const key = url.href;
    const cached = this.buffers.get(key);
    if (cached) return Promise.resolve(cached);
    let pending = this.bufferPromises.get(key);
    if (!pending) {
      if (generation !== this.generation) return Promise.reject(new Error("Improved hand asset request was superseded."));
      const load = this.fetcher(url).then(async (response) => {
        if (!response.ok) throw new Error(`Improved hand asset request failed (${response.status}): ${url.pathname}`);
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength < 20) throw new Error(`Improved hand asset is empty or truncated: ${url.pathname}`);
        if (generation !== this.generation) throw new Error("Improved hand asset request was superseded.");
        this.buffers.set(key, buffer);
        return buffer;
      }).catch((error: unknown) => {
        if (this.bufferPromises.get(key) === load) this.bufferPromises.delete(key);
        throw error;
      });
      pending = load;
      this.bufferPromises.set(key, load);
    }
    return pending;
  }
}

export interface ImprovedHandTextureLease {
  baseColor: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
  release(): void;
}

interface CachedTexture {
  texture: THREE.Texture;
  refs: number;
}

/** Shared, reference-counted map cache used by both hands and all LODs. */
export class ImprovedHandTextureCache {
  private readonly textures = new Map<string, CachedTexture>();
  private readonly pending = new Map<string, Promise<THREE.Texture>>();

  public constructor(
    private readonly loader: Pick<THREE.TextureLoader, "loadAsync"> = new THREE.TextureLoader(),
  ) {}

  public async acquire(asset: ImprovedHandAsset): Promise<ImprovedHandTextureLease> {
    const mapUrls = {
      baseColor: resolveModelRelativeUrl(asset.manifestUrl, asset.textureSet.baseColor).href,
      normal: resolveModelRelativeUrl(asset.manifestUrl, asset.textureSet.normal).href,
      roughness: resolveModelRelativeUrl(asset.manifestUrl, asset.textureSet.roughness).href,
    };
    const acquired: string[] = [];
    let baseColor: THREE.Texture;
    let normal: THREE.Texture;
    let roughness: THREE.Texture;
    try {
      baseColor = await this.acquireOne(mapUrls.baseColor, THREE.SRGBColorSpace);
      acquired.push(mapUrls.baseColor);
      normal = await this.acquireOne(mapUrls.normal, THREE.NoColorSpace);
      acquired.push(mapUrls.normal);
      roughness = await this.acquireOne(mapUrls.roughness, THREE.NoColorSpace);
      acquired.push(mapUrls.roughness);
    } catch (error) {
      for (const url of acquired) this.releaseOne(url);
      throw error;
    }
    let released = false;
    return {
      baseColor,
      normal,
      roughness,
      release: () => {
        if (released) return;
        released = true;
        for (const url of Object.values(mapUrls)) this.releaseOne(url);
      },
    };
  }

  public getCacheStats(): ImprovedHandTextureCacheStats {
    let estimatedBaseBytes = 0;
    for (const cached of this.textures.values()) {
      const image = cached.texture.image as { width?: number; height?: number } | undefined;
      if (image?.width && image.height) estimatedBaseBytes += image.width * image.height * 4;
    }
    return { count: this.textures.size, estimatedBaseBytes };
  }

  private async acquireOne(url: string, colorSpace: THREE.ColorSpace): Promise<THREE.Texture> {
    let cached = this.textures.get(url);
    if (cached) {
      cached.refs += 1;
      return cached.texture;
    }
    let pending = this.pending.get(url);
    if (!pending) {
      pending = this.loader.loadAsync(url).then((texture) => {
        texture.colorSpace = colorSpace;
        texture.flipY = false;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.needsUpdate = true;
        this.textures.set(url, { texture, refs: 0 });
        return texture;
      }).finally(() => this.pending.delete(url));
      this.pending.set(url, pending);
    }
    const texture = await pending;
    cached = this.textures.get(url);
    if (!cached) throw new Error("Improved hand texture was released while loading.");
    cached.refs += 1;
    return texture;
  }

  private releaseOne(url: string): void {
    const cached = this.textures.get(url);
    if (!cached) return;
    cached.refs = Math.max(0, cached.refs - 1);
    if (cached.refs === 0) {
      cached.texture.dispose();
      this.textures.delete(url);
    }
  }
}

export const improvedHandAssetLoader = new ImprovedHandAssetLoader();
export const improvedHandTextureCache = new ImprovedHandTextureCache();
