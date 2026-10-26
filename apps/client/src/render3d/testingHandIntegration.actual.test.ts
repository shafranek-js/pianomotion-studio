// @ts-expect-error Vitest uses Node fs for real GLB conformance; browser tsconfig excludes Node types.
import { readFileSync } from "node:fs";
import { transferWebxrSkinToAnatomicalSurface } from "./testingHandSkin";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Hand3DMeshGroup, buildImprovedHandGlbRig, parseHandGlbRig, type HandModelRuntimeDependencies } from "./handRigBuilder";
import {
  type ImprovedHandAsset,
  type ImprovedHandTextureLease,
  IMPROVED_HAND_JOINT_NAMES,
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

        // Cross-check that runtime Testing actually uses the same GLB geometry
        // and WebXR reference as the standalone asset-registry experiment.
        const sourceLod = manifest.hands[side].lods[2]!;
        const sourceBytes = readFileSync(new URL(sourceLod.url, directory));
        const sourceBuffer = sourceBytes.buffer.slice(
          sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength,
        ) as ArrayBuffer;
        const referenceGroup = new THREE.Group();
        const referenceMaterial = new THREE.MeshPhysicalMaterial();
        const independentWebxr = parseHandGlbRig(side, referenceMaterial, referenceGroup);
        const independentAnatomy = buildImprovedHandGlbRig(
          side, referenceMaterial, referenceGroup, sourceBuffer, sourceLod,
          IMPROVED_HAND_JOINT_NAMES, manifest.extras,
        );
        try {
          const independentSurface = transferWebxrSkinToAnatomicalSurface(
            independentAnatomy.skinnedMesh.geometry,
            independentWebxr.skinnedMesh.geometry,
            independentWebxr.skinnedMesh.skeleton.bones.length,
            {
              anatomicalBoneNames: independentAnatomy.skinnedMesh.skeleton.bones.map(bone => bone.name),
              webxrBoneNames: independentWebxr.skinnedMesh.skeleton.bones.map(bone => bone.name),
            },
          );
          const independentlyMeasured = independentSurface.userData.testingTransferStats as
            typeof registration;
          console.info("[Testing runtime/standalone registration check]", side, JSON.stringify({
            runtime: registration,
            standalone: independentlyMeasured,
          }));
          expect(registration.nearestWebxrVertexMeanInches)
            .toBeCloseTo(independentlyMeasured.nearestWebxrVertexMeanInches, 6);
          expect(registration.nearestWebxrVertexP95Inches)
            .toBeCloseTo(independentlyMeasured.nearestWebxrVertexP95Inches, 6);
          expect(independentSurface.getAttribute("position").array)
            .toEqual(mesh!.geometry.getAttribute("position").array);
          independentSurface.dispose();
        } finally {
          independentWebxr.skinnedMesh.geometry.dispose();
          independentWebxr.skinnedMesh.skeleton.dispose();
          independentAnatomy.skinnedMesh.geometry.dispose();
          independentAnatomy.skinnedMesh.skeleton.dispose();
          referenceMaterial.dispose();
        }
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
