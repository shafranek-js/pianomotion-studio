import { describe, expect, it, vi } from "vitest";
import {
  ImprovedHandAssetLoader,
  IMPROVED_HAND_JOINT_NAMES,
  type ImprovedHandManifest,
  validateImprovedHandManifest,
} from "./improvedHandAssets";

const manifestUrl = new URL("https://assets.example.test/models/hands/improved/manifest.json");
const textureSet = {
  baseColor: "textures/skin-base.png",
  normal: "textures/skin-normal.png",
  roughness: "textures/skin-roughness.png",
  flipY: false as const,
  baseColorColorSpace: "srgb" as const,
  normalColorSpace: "linear" as const,
  roughnessColorSpace: "linear" as const,
};

function makeManifest(): ImprovedHandManifest {
  const makeLods = (side: "left" | "right") => [0, 1, 2].map((level) => ({
    level: level as 0 | 1 | 2,
    url: `${side}-lod${level}.glb`,
    triangles: 1,
    vertices: 3,
    textureSet: level === 2 ? "low" as const : "high" as const,
    boundaryVertices: [0, 1, 2],
    boundaryLoops: [[0, 1, 2]],
  }));
  return {
    schemaVersion: 1,
    modelId: "anatomical-improved",
    source: { uri: "hand_standard.glb", sha256: "a".repeat(64), vertices: 3, triangles: 1 },
    coordinateFrame: {
      unit: "meters",
      handedness: "right",
      boneForwardAxis: "-Z",
      normalTextureFlipY: false,
    },
    jointNames: [...IMPROVED_HAND_JOINT_NAMES],
    extras: {
      restDorsalAxis: [0, 1, 0],
      boneFrames: {
        left: Object.fromEntries(IMPROVED_HAND_JOINT_NAMES.map((name) => [name, {
          forward: [0, 0, -1], dorsal: [0, 1, 0], hinge: [1, 0, 0],
        }])),
        right: Object.fromEntries(IMPROVED_HAND_JOINT_NAMES.map((name) => [name, {
          forward: [0, 0, -1], dorsal: [0, 1, 0], hinge: [1, 0, 0],
        }])),
      },
    },
    textures: { high: { ...textureSet }, low: { ...textureSet, baseColor: "textures/skin-low.png" } },
    hands: { left: { lods: makeLods("left") }, right: { lods: makeLods("right") } },
  };
}

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

describe("improved hand asset loading", () => {
  it("fetches only the requested LOD and reports retained GLB bytes", async () => {
    const requested: string[] = [];
    const loader = new ImprovedHandAssetLoader(async (input) => {
      const url = String(input);
      requested.push(url);
      return url === manifestUrl.href
        ? okJson(makeManifest())
        : new Response(new Uint8Array(32), { status: 200 });
    }, manifestUrl);

    const asset = await loader.load("right", 2);

    expect(asset.lod.url).toBe("right-lod2.glb");
    expect(requested).toEqual([
      manifestUrl.href,
      "https://assets.example.test/models/hands/improved/right-lod2.glb",
    ]);
    expect(loader.getCacheStats()).toEqual({ count: 1, retainedGlbBytes: 32 });
  });

  it("rejects an escaping texture path before fetching any GLB", async () => {
    const invalid = makeManifest();
    invalid.textures.high.baseColor = "../../../outside.png";
    const requested: string[] = [];
    const loader = new ImprovedHandAssetLoader(async (input) => {
      requested.push(String(input));
      return String(input) === manifestUrl.href
        ? okJson(invalid)
        : new Response(new Uint8Array(32), { status: 200 });
    }, manifestUrl);

    await expect(loader.load("left", 0)).rejects.toThrow(/escapes its model directory/i);
    expect(requested).toEqual([manifestUrl.href]);
  });

  it("rejects a rolled dorsal basis before any model asset can load", () => {
    const invalid = makeManifest();
    invalid.extras.boneFrames.left["index-finger-phalanx-proximal"]!.dorsal = [0, 0, 1];

    expect(() => validateImprovedHandManifest(invalid)).toThrow(/rolled|right-handed/i);
  });

  it("accepts the explicit palm wrist profile and rejects unknown profile versions", () => {
    const palmFrame = makeManifest();
    palmFrame.extras.wristFrameProfile = "palm-mcp-v1";
    expect(validateImprovedHandManifest(palmFrame).extras.wristFrameProfile).toBe("palm-mcp-v1");

    const staleProfile = makeManifest();
    (staleProfile.extras as { wristFrameProfile?: string }).wristFrameProfile = "palm-mcp-v0";
    expect(() => validateImprovedHandManifest(staleProfile)).toThrow(/unsupported wrist frame profile/i);

    const legacy = makeManifest();
    expect(validateImprovedHandManifest(legacy).extras.wristFrameProfile).toBeUndefined();
  });

  it("prevents a cleared in-flight GLB response from repopulating the cache", async () => {
    const requested: string[] = [];
    let finishGlb: ((response: Response) => void) | undefined;
    const glbResponse = new Promise<Response>((resolve) => { finishGlb = resolve; });
    const loader = new ImprovedHandAssetLoader(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === manifestUrl.href) return okJson(makeManifest());
      return glbResponse;
    }, manifestUrl);

    const loading = loader.load("left", 1);
    await vi.waitFor(() => expect(requested.length).toBe(2));
    loader.clear();
    finishGlb!(new Response(new Uint8Array(64), { status: 200 }));

    await expect(loading).rejects.toThrow(/superseded/i);
    expect(loader.getCacheStats()).toEqual({ count: 0, retainedGlbBytes: 0 });
  });
});
