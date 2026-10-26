// @ts-expect-error Vitest uses Node fs for real GLB conformance; browser tsconfig excludes Node types.
import { readFileSync } from "node:fs";
import { transferWebxrSkinToAnatomicalSurface } from "./testingHandSkin";
import { measureTestingHandDeformation } from "./testingHandDeformationQA";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { MotionPose } from "@handthesia/contracts";
import { DEFAULT_SKIN_SETTINGS } from "../render/skins";
import { Hand3DMeshGroup, buildImprovedHandGlbRig, parseHandGlbRig, type HandModelRuntimeDependencies } from "./handRigBuilder";
import {
  type ImprovedHandAsset,
  type ImprovedHandTextureLease,
  IMPROVED_HAND_JOINT_NAMES,
  validateImprovedHandManifest,
} from "./improvedHandAssets";

const manifestUrl = new URL("../../public/models/hands/improved/manifest.json", import.meta.url);

function makeWebxrComparisonPose(hand: "left" | "right"): MotionPose {
  const x = hand === "left" ? 18 : 30;
  const bones: MotionPose["bones"] = [
    { a: [x - 1, -1, 0.9], b: [x - 1, 0, 0.9], kind: "forearm" },
    { a: [x + 1, -1, 0.9], b: [x + 1, 0, 0.9], kind: "forearm" },
  ];
  const joints: MotionPose["joints"] = [
    { point: [x - 1, 0, 0.9], kind: "wrist" },
    { point: [x + 1, 0, 0.9], kind: "wrist" },
  ];
  for (const finger of [2, 3, 4, 5, 1]) {
    const xx = x + (finger - 3.5) * 0.7;
    const points: [number, number, number][] = finger === 1 ? [
      [xx + 0.4, 0.5, 0.8], [xx, 1.2, 0.7],
      [xx - 0.3, 1.8, 0.45], [xx - 0.5, 2.6, 0.15],
    ] : [
      [xx - 0.2, 0.25, 0.8], [xx, 1.0, 0.8],
      [xx, 2.0, 0.5], [xx, 3.0, 0.2], [xx, 4.0, 0.1],
    ];
    const kinds = finger === 1
      ? ["metacarpal", "proximal", "distal"] as const
      : ["metacarpal", "proximal", "middle", "distal"] as const;
    for (let i = 0; i < kinds.length; i++) {
      bones.push({ a: points[i]!, b: points[i + 1]!, kind: kinds[i]! });
    }
    joints.push({ point: points.at(-1)!, kind: "tip" });
  }
  return { hand, transportTimeSeconds: 0.75, layerOrder: 0, bones, joints };
}

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
        const neutralSurface = measureTestingHandDeformation(mesh!);
        expect(neutralSurface.areaRatioMin).toBeGreaterThan(0.99);
        expect(neutralSurface.areaRatioMax).toBeLessThan(1.01);
        expect(neutralSurface.edgeCompressionMin).toBeGreaterThan(0.99);
        expect(neutralSurface.edgeStretchMax).toBeLessThan(1.01);
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

        // WebXR is the motion oracle: identical input poses and hover must
        // produce matching world transforms for *every* bone in Testing.
        const referenceMotion = new Hand3DMeshGroup(side, "webxr");
        try {
          const pose = makeWebxrComparisonPose(side);
          for (const hover of [0, 0.65]) {
            const serializedPose = JSON.stringify(pose);
            referenceMotion.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, hover);
            model.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, hover);
            referenceMotion.group.updateMatrixWorld(true);
            model.group.updateMatrixWorld(true);
            for (const name of IMPROVED_HAND_JOINT_NAMES) {
              const expected = referenceMotion.getBone(name)!;
              const actual = model.getBone(name)!;
              for (let axis = 0; axis < 16; axis++) {
                expect(actual.matrixWorld.elements[axis], `${side} ${name} hover=${hover}`)
                  .toBeCloseTo(expected.matrixWorld.elements[axis]!, 5);
              }
            }
            expect(JSON.stringify(pose)).toBe(serializedPose);
            const deformation = measureTestingHandDeformation(mesh!);
            console.info("[Testing skinned triangle deformation]", side, "hover=" + hover,
              JSON.stringify(deformation));
            expect(deformation.inspectedTriangles).toBeGreaterThan(7000);
            expect(deformation.edgeCompressionMin).toBeGreaterThan(0);
            expect(deformation.edgeStretchMax).toBeLessThan(100);
            expect(deformation.areaRatioMin).toBeGreaterThan(0);
            expect(deformation.areaRatioMax).toBeLessThan(100);
          }
        } finally {
          referenceMotion.dispose();
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

        // Real camera changes can move LOD2 -> LOD1 -> LOD0 and back.
        // Verify the Testing model remains ready, each new surface has valid
        // WebXR weight transfer, and all four texture leases are released.
        for (const level of [1, 0, 2] as const) {
          model.setHandModel("testing", level);
          await model.waitForHandModelReady();
          const expected = manifest.hands[side].lods[level]!;
          expect(model.getHandModelDiagnostics()).toMatchObject({
            requestedModel: "testing",
            loadedModel: "testing",
            loadedLod: level,
            triangles: expected.triangles,
            state: "ready",
          });
          let loaded: THREE.SkinnedMesh | null = null;
          model.group.traverse(node => {
            if (node instanceof THREE.SkinnedMesh && node.geometry.userData.testingWebxrSkinTransfer) {
              loaded = node;
            }
          });
          expect(loaded).not.toBeNull();
          const surface = loaded! as THREE.SkinnedMesh;
          expect(surface.geometry.getAttribute("position").count).toBe(expected.vertices);
          expect(surface.skeleton.bones).toHaveLength(25);
          const jointIndices = surface.geometry.getAttribute("skinIndex");
          const jointWeights = surface.geometry.getAttribute("skinWeight");
          for (let vertex = 0; vertex < jointWeights.count; vertex += 17) {
            let total = 0;
            for (let slot = 0; slot < 4; slot++) {
              const joint = jointIndices.getComponent(vertex, slot);
              const weight = jointWeights.getComponent(vertex, slot);
              expect(joint).toBeGreaterThanOrEqual(0);
              expect(joint).toBeLessThan(25);
              expect(Number.isFinite(weight)).toBe(true);
              total += weight;
            }
            expect(total).toBeCloseTo(1, 4);
          }
        }
      } finally {
        model.dispose();
        textures.baseColor.dispose();
        textures.normal.dispose();
        textures.roughness.dispose();
      }
      expect(leaseReleases).toBe(4);
    }
  });
});
