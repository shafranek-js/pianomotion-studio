// @ts-expect-error Integration test runs in Node; browser tsconfig intentionally excludes Node types.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildImprovedHandGlbRig, parseHandGlbRig } from "./handRigBuilder";
import { IMPROVED_HAND_JOINT_NAMES, validateImprovedHandManifest } from "./improvedHandAssets";
import { measureTestingCrossFingerWeights, transferWebxrSkinToAnatomicalSurface } from "./testingHandSkin";
import { registerWebxrSamplingSurface } from "./testingHandRegistration";
import { transferTestingWeightsInBoneFrames } from "./testingHandBoneFrameTransfer";

describe("Testing hand rest-space rig registration experiments", () => {
  it("measures raw and bone-registered weight transfer on both real LOD2 hand assets", () => {
    const manifestUrl = new URL("../../public/models/hands/improved/manifest.json", import.meta.url);
    const manifest = validateImprovedHandManifest(JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown);
    for (const side of ["left", "right"] as const) {
      const lod = manifest.hands[side].lods[2]!;
      const url = new URL(lod.url, manifestUrl);
      const bytes = readFileSync(url);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const group = new THREE.Group();
      const material = new THREE.MeshPhysicalMaterial();
      const webxr = parseHandGlbRig(side, material, group);
      const anatomy = buildImprovedHandGlbRig(side, material, group, buffer, lod,
        IMPROVED_HAND_JOINT_NAMES, manifest.extras);
      try {
        const raw = transferWebxrSkinToAnatomicalSurface(
          anatomy.skinnedMesh.geometry, webxr.skinnedMesh.geometry, webxr.skinnedMesh.skeleton.bones.length);
        const registered = registerWebxrSamplingSurface(
          webxr.skinnedMesh.geometry, webxr.skinnedMesh.skeleton.bones, anatomy.skinnedMesh.skeleton.bones);
        const corrected = transferWebxrSkinToAnatomicalSurface(
          anatomy.skinnedMesh.geometry, registered, webxr.skinnedMesh.skeleton.bones.length);
        const scaledReference = registerWebxrSamplingSurface(
          webxr.skinnedMesh.geometry, webxr.skinnedMesh.skeleton.bones,
          anatomy.skinnedMesh.skeleton.bones, { axialScale: true });
        const axialCorrected = transferWebxrSkinToAnatomicalSurface(
          anatomy.skinnedMesh.geometry, scaledReference, webxr.skinnedMesh.skeleton.bones.length);
        const labels = {
          anatomicalBoneNames: anatomy.skinnedMesh.skeleton.bones.map(bone => bone.name),
          webxrBoneNames: webxr.skinnedMesh.skeleton.bones.map(bone => bone.name),
        };
        const digitAware = transferWebxrSkinToAnatomicalSurface(
          anatomy.skinnedMesh.geometry, webxr.skinnedMesh.geometry,
          webxr.skinnedMesh.skeleton.bones.length, labels,
        );
        // Bone-frame transfer registers every anatomical joint to the
        // corresponding WebXR rest joint before looking up skin weights.
        // This is diagnostic-only until the real-pose distortion improves.
        const boneFrameCandidate = transferTestingWeightsInBoneFrames(
          anatomy.skinnedMesh.geometry, webxr.skinnedMesh.geometry,
          anatomy.skinnedMesh.skeleton.bones,
          webxr.skinnedMesh.skeleton.bones,
          labels,
        );
        const baselineNearest = digitAware.userData.testingTransferStats as {
          nearestWebxrVertexMeanInches: number;
          nearestWebxrVertexP95Inches: number;
        };
        const registeredNearest = boneFrameCandidate.userData.testingTransferStats as
          typeof baselineNearest;
        const boneFrameBleed = measureTestingCrossFingerWeights(
          boneFrameCandidate, anatomy.skinnedMesh.geometry, labels,
        );
        console.info("[Testing bone-frame registration A/B]", side, JSON.stringify({
          directNearest: baselineNearest,
          frameNearest: registeredNearest,
          boneFrameMapping: boneFrameCandidate.userData.testingBoneFrameMapping,
          boneFrameBleed,
        }));
        expect(boneFrameCandidate.getAttribute("position").array)
          .toEqual(anatomy.skinnedMesh.geometry.getAttribute("position").array);
        expect(Number.isFinite(registeredNearest.nearestWebxrVertexMeanInches)).toBe(true);
        expect(boneFrameBleed.inspectedVertices).toBeGreaterThan(100);
        expect(boneFrameBleed.verticesAboveTenPercent).toBe(0);
        boneFrameCandidate.dispose();
        const blindBleed = measureTestingCrossFingerWeights(raw, anatomy.skinnedMesh.geometry, labels);
        const digitBleed = measureTestingCrossFingerWeights(digitAware, anatomy.skinnedMesh.geometry, labels);
        console.info("[Testing digit-aware real GLB A/B]", side, JSON.stringify({ blindBleed, digitBleed }));
        expect(digitBleed.inspectedVertices).toBeGreaterThan(100);
        expect(digitBleed.verticesAboveTenPercent).toBeLessThanOrEqual(blindBleed.verticesAboveTenPercent);
        expect(digitBleed.meanForeignDigitWeight).toBeLessThanOrEqual(blindBleed.meanForeignDigitWeight + 1e-7);
        // In regions that the native anatomical skin assigns confidently to
        // one digit, Testing must never use a different digit's bone.
        expect(digitBleed.maximumForeignDigitWeight).toBeLessThan(1e-6);
        expect(digitBleed.verticesAboveTenPercent).toBe(0);
        digitAware.dispose();

        const metrics = {
          raw: raw.userData.testingTransferStats,
          registered: corrected.userData.testingTransferStats,
          registeredAxial: axialCorrected.userData.testingTransferStats,
        };
        console.info("[Testing bind registration A/B]", side, JSON.stringify(metrics));
        for (const values of Object.values(metrics)) {
          const metrics = values as {
            nearestWebxrVertexMeanInches: number;
            nearestWebxrVertexP95Inches: number;
          };
          expect(Number.isFinite(metrics.nearestWebxrVertexMeanInches)).toBe(true);
          expect(Number.isFinite(metrics.nearestWebxrVertexP95Inches)).toBe(true);
        }
        axialCorrected.dispose();
        scaledReference.dispose();
        corrected.dispose();
        registered.dispose();
        raw.dispose();
      } finally {
        webxr.skinnedMesh.geometry.dispose();
        webxr.skinnedMesh.skeleton.dispose();
        anatomy.skinnedMesh.geometry.dispose();
        anatomy.skinnedMesh.skeleton.dispose();
        material.dispose();
      }
    }
  });
});
