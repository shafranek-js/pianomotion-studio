// @ts-expect-error Vitest uses Node fs for real GLB conformance; browser tsconfig excludes Node types.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Hand3DMeshGroup, type HandModelRuntimeDependencies } from "./handRigBuilder";
import {
  type ImprovedHandAsset,
  type ImprovedHandTextureLease,
  validateImprovedHandManifest,
} from "./improvedHandAssets";

const manifestUrl = new URL("../../public/models/hands/improved/manifest.json", import.meta.url);

describe("Testing hand: real anatomical shell on original WebXR skeleton", () => {
  it("loads both hands at LOD2 without changing the original bind skeleton", async () => {
    const manifest = validateImprovedHandManifest(JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown);
    const directory = new URL(".", manifestUrl);

    for (const side of ["left", "right"] as const) {
      let leaseReleases = 0;
      const textures: ImprovedHandTextureLease = {
        baseColor: new THREE.Texture(),
        normal: new THREE.Texture(),
        roughness: new THREE.Texture(),
        release: () => { leaseReleases++; },
      };
      const dependencies: HandModelRuntimeDependencies = {
        assetLoader: {
          load: async (hand, level) => {
            const lod = manifest.hands[hand].lods[level]!;
            const bytes = readFileSync(new URL(lod.url, directory));
            const asset: ImprovedHandAsset = {
              manifest,
              manifestUrl,
              hand,
              lod,
              buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
              textureSet: manifest.textures[lod.textureSet],
            };
            return asset;
          },
          getCacheStats: () => ({ count: 1, retainedGlbBytes: 200 }),
        },
        textureCache: {
          acquire: async () => textures,
          getCacheStats: () => ({ count: 3, estimatedBaseBytes: 300 }),
        },
      };
      const model = new Hand3DMeshGroup(side, "webxr", dependencies);
      const sourceBones = new Map(
        ["wrist", "thumb-metacarpal", "index-finger-metacarpal", "middle-finger-phalanx-proximal",
          "pinky-finger-phalanx-distal", "ring-finger-tip"]
          .map((name) => [name, model.getBone(name)!.position.clone()]),
      );
      try {
        model.setHandModel("testing", 2);
        await model.waitForHandModelReady();
        expect(model.getHandModel()).toBe("testing");
        expect(model.getHandModelDiagnostics()).toMatchObject({
          requestedModel: "testing",
          loadedModel: "testing",
          loadedLod: 2,
          state: "ready",
          triangles: 8000,
        });

        let mesh: THREE.SkinnedMesh | undefined;
        model.group.traverse((node) => {
          if (node instanceof THREE.SkinnedMesh) mesh = node;
        });
        expect(mesh).toBeDefined();
        expect(mesh!.geometry.getAttribute("position").count).toBe(manifest.hands[side].lods[2]!.vertices);
        expect(mesh!.geometry.userData.testingWebxrSkinTransfer).toBe(true);
        const registration = mesh!.geometry.userData.testingTransferStats as {
          vertexCount: number;
          nearestWebxrVertexMeanInches: number;
          nearestWebxrVertexP95Inches: number;
          nearestWebxrVertexMaxInches: number;
          verticesOverHalfInch: number;
        };
        expect(registration.vertexCount).toBe(mesh!.geometry.getAttribute("position").count);
        expect(registration.nearestWebxrVertexMeanInches).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(registration.nearestWebxrVertexP95Inches)).toBe(true);
        expect(Number.isFinite(registration.nearestWebxrVertexMaxInches)).toBe(true);
        // Regression diagnostic only: interpretation requires anatomical pose review.
        console.info("[Testing bind-space registration]", side, JSON.stringify(registration));
        expect(mesh!.skeleton.bones).toHaveLength(25);
        expect(model.skinMaterial.map).toBe(textures.baseColor);
        expect(model.skinMaterial.normalMap).toBe(textures.normal);
        expect(model.skinMaterial.vertexColors).toBe(false);

        // The original WebXR bind skeleton, not the anatomical inferred bones,
        // remains the source of all subsequent 3D joint transformations.
        for (const [name, position] of sourceBones) {
          expect(model.getBone(name)!.position.distanceTo(position)).toBeLessThan(1e-5);
        }
        const weights = mesh!.geometry.getAttribute("skinWeight");
        const indices = mesh!.geometry.getAttribute("skinIndex");
        for (let i = 0; i < weights.count; i++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            expect(indices.getComponent(i, k)).toBeGreaterThanOrEqual(0);
            expect(indices.getComponent(i, k)).toBeLessThan(25);
            sum += weights.getComponent(i, k);
          }
          expect(sum).toBeCloseTo(1, 4);
        }
      } finally {
        model.dispose();
        textures.baseColor.dispose();
        textures.normal.dispose();
        textures.roughness.dispose();
      }
      expect(leaseReleases).toBe(1);
    }
  });
});
