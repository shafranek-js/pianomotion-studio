// @ts-expect-error Integration test runs in Node; browser tsconfig intentionally excludes Node types.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildImprovedHandGlbRig, parseHandGlbRig } from "./handRigBuilder";
import { IMPROVED_HAND_JOINT_NAMES, validateImprovedHandManifest } from "./improvedHandAssets";
import { transferWebxrSkinToAnatomicalSurface } from "./testingHandSkin";
import { registerWebxrSamplingSurface } from "./testingHandRegistration";

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
