// @ts-expect-error Vitest uses Node fs for real GLB conformance; browser tsconfig excludes Node types.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { transferWebxrSkinToAnatomicalSurface } from "./testingHandSkin";
import { measureTestingHandDeformation } from "./testingHandDeformationQA";
import { regularizeTestingSkinWeights } from "./testingHandWeightRegularizer";
import { transferAnatomicalWeightsToWebxrSkeleton } from "./testingHandSemanticWeights";
import { transferTestingWeightsInBoneFrames } from "./testingHandBoneFrameTransfer";
import { measureTestingFixedThumbRegion } from "./testingHandThumbQA";
import { measureTestingBindAlignment, type TestingBindAlignmentSnapshot } from "./testingHandBindAlignment";
import { locateTestingHandDeformationHotspots } from "./testingHandDeformationHotspots";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { MotionPose } from "@handthesia/contracts";
import { DEFAULT_SKIN_SETTINGS } from "../render/skins";
import type { ImprovedHandContactTarget } from "./improvedHandContact";
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
        // Overlay must be optional, use real GLB joint/pad landmarks, and
        // never mutate the neutral POSITION buffer or driver bind pose.
        const originalPositions = Array.from(mesh!.geometry.getAttribute("position").array);
        model.setTestingBindAlignmentOverlay(true);
        const markerNodes: THREE.Object3D[] = [];
        model.group.traverse(node => {
          if (node.name.startsWith("Testing alignment ")) markerNodes.push(node);
        });
        const nativeMarkers = markerNodes.filter(node => node.name.startsWith("Testing alignment native "));
        const webxrMarkers = markerNodes.filter(node => node.name.startsWith("Testing alignment WebXR "));
        const contactMarkers = markerNodes.filter(node => node.name.startsWith("Testing alignment pad "));
        expect(nativeMarkers.length).toBeGreaterThanOrEqual(20);
        expect(webxrMarkers).toHaveLength(nativeMarkers.length);
        expect(contactMarkers).toHaveLength(5);
        expect(contactMarkers.every(node =>
          Number.isFinite(node.position.x) && Number.isFinite(node.position.y) &&
          Number.isFinite(node.position.z))).toBe(true);
        model.setTestingBindAlignmentOverlay(false);
        let remaining = 0;
        model.group.traverse(node => {
          if (node.name.startsWith("Testing alignment ")) remaining++;
        });
        expect(remaining).toBe(0);
        expect(Array.from(mesh!.geometry.getAttribute("position").array)).toEqual(originalPositions);
        const neutralSurface = measureTestingHandDeformation(mesh!);
        expect(neutralSurface.areaRatioMin).toBeGreaterThan(0.99);
        expect(neutralSurface.areaRatioMax).toBeLessThan(1.01);
        expect(neutralSurface.edgeCompressionMin).toBeGreaterThan(0.99);
        expect(neutralSurface.edgeStretchMax).toBeLessThan(1.01);
        const alignment = mesh!.geometry.userData.testingBindAlignment as TestingBindAlignmentSnapshot;
        expect(alignment.method).toBe("source-rig-origins-not-annotated-surface-knuckles");
        expect(alignment.side).toBe(side);
        expect(alignment.joints.length).toBeGreaterThanOrEqual(20);
        expect(alignment.segments.length).toBeGreaterThanOrEqual(15);
        expect(alignment.pads).toHaveLength(5);
        expect(alignment.missingNativeBoneNames).toEqual([]);
        for (const landmark of alignment.joints) {
          expect(Number.isFinite(landmark.rawOffsetMm)).toBe(true);
          expect(Number.isFinite(landmark.wristLocalOffsetMm)).toBe(true);
          expect(Number.isFinite(landmark.bindAxisDifferenceDegrees)).toBe(true);
        }
        for (const pad of alignment.pads) {
          expect(pad.vertexIds.length).toBeGreaterThan(0);
          expect(pad.centroidToWebxrTipMm).toBeGreaterThanOrEqual(0);
        }
        // These are SOURCE BONE origins and native fingertip-vertex
        // centroids, not manually annotated physiological rotation axes.
        console.info("[Testing source-to-WebXR bind alignment]", JSON.stringify({
          side, originCount: alignment.joints.length, segmentCount: alignment.segments.length,
          meanMm: alignment.jointOffsetMeanMm, p95Mm: alignment.jointOffsetP95Mm,
          maxMm: alignment.jointOffsetMaxMm, wristLocalP95Mm: alignment.wristLocalP95Mm,
          pads: alignment.pads.map(pad => ({
            finger: pad.finger, padGapMm: pad.centroidToWebxrTipMm,
          })),
          largestJointOffsets: [...alignment.joints]
            .sort((a, b) => b.wristLocalOffsetMm - a.wristLocalOffsetMm)
            .slice(0, 5).map(j => [j.name, j.wristLocalOffsetMm]),
        }));
        // Save the exact joint, phalanx and contact-pad records, rather
        // than a rounded screenshot estimate. CI uploads both hand reports.
        mkdirSync("scratch/testing-hand-bind-alignment", { recursive: true });
        writeFileSync(
          "scratch/testing-hand-bind-alignment/" + side + ".json",
          JSON.stringify(alignment, null, 2) + "\n", "utf8",
        );
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
        let smootherCandidate: THREE.BufferGeometry | null = null;
        let semanticCandidate: THREE.BufferGeometry | null = null;
        let thumbCalibratedCandidate: THREE.BufferGeometry | null = null;
        let thumbAnatomySource: THREE.BufferGeometry | null = null;
        let thumbAnatomyNames: string[] = [];
        let untouchedNonThumb: Uint8Array | null = null;
        const partialThumbCandidates: Array<{ strength: number; geometry: THREE.BufferGeometry }> = [];
        try {
          const standaloneAlignment = measureTestingBindAlignment(
          side, independentAnatomy, independentWebxr,
        );
        expect(standaloneAlignment.joints).toEqual(alignment.joints);
        expect(standaloneAlignment.segments).toEqual(alignment.segments);
        expect(standaloneAlignment.pads).toEqual(alignment.pads);
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
          smootherCandidate = regularizeTestingSkinWeights(
            independentSurface,
            independentAnatomy.skinnedMesh.geometry,
            {
              anatomicalBoneNames: independentAnatomy.skinnedMesh.skeleton.bones.map(bone => bone.name),
              webxrBoneNames: independentWebxr.skinnedMesh.skeleton.bones.map(bone => bone.name),
            },
          );
          semanticCandidate = transferAnatomicalWeightsToWebxrSkeleton(
            independentAnatomy.skinnedMesh.geometry,
            independentAnatomy.skinnedMesh.skeleton.bones,
            independentWebxr.skinnedMesh.skeleton.bones,
          );
          thumbAnatomySource = independentAnatomy.skinnedMesh.geometry.clone();
          thumbAnatomyNames = independentAnatomy.skinnedMesh.skeleton.bones.map(bone => bone.name);
          const nativeIndex = thumbAnatomySource.getAttribute("skinIndex");
          const nativeWeight = thumbAnatomySource.getAttribute("skinWeight");
          untouchedNonThumb = new Uint8Array(nativeWeight.count);
          for (let vertex = 0; vertex < nativeWeight.count; vertex++) {
            let thumb = 0;
            for (let slot = 0; slot < 4; slot++) {
              const bone = nativeIndex.getComponent(vertex, slot);
              if (thumbAnatomyNames[bone]?.startsWith("thumb-")) {
                thumb += nativeWeight.getComponent(vertex, slot);
              }
            }
            untouchedNonThumb[vertex] = thumb <= 0.10 ? 1 : 0;
          }
          thumbCalibratedCandidate = transferTestingWeightsInBoneFrames(
            independentAnatomy.skinnedMesh.geometry,
            independentWebxr.skinnedMesh.geometry,
            independentAnatomy.skinnedMesh.skeleton.bones,
            independentWebxr.skinnedMesh.skeleton.bones,
            {
              anatomicalBoneNames: independentAnatomy.skinnedMesh.skeleton.bones.map(bone => bone.name),
              webxrBoneNames: independentWebxr.skinnedMesh.skeleton.bones.map(bone => bone.name),
            },
            { thumbAxialScale: true },
          );
          for (const strength of [0.25, 0.5, 0.75]) {
            partialThumbCandidates.push({
              strength,
              geometry: transferTestingWeightsInBoneFrames(
                independentAnatomy.skinnedMesh.geometry,
                independentWebxr.skinnedMesh.geometry,
                independentAnatomy.skinnedMesh.skeleton.bones,
                independentWebxr.skinnedMesh.skeleton.bones,
                {
                  anatomicalBoneNames: independentAnatomy.skinnedMesh.skeleton.bones.map(bone => bone.name),
                  webxrBoneNames: independentWebxr.skinnedMesh.skeleton.bones.map(bone => bone.name),
                },
                { thumbAxialStrength: strength },
              ),
            });
          }
          const semanticIndices = semanticCandidate.getAttribute("skinIndex");
          const semanticWeights = semanticCandidate.getAttribute("skinWeight");
          for (let i = 0; i < semanticIndices.count; i += 37) {
            let total = 0;
            for (let k = 0; k < 4; k++) {
              expect(semanticIndices.getComponent(i, k)).toBeLessThan(25);
              total += semanticWeights.getComponent(i, k);
            }
            expect(total).toBeCloseTo(1, 4);
          }
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
        const experimentalSurface = new THREE.SkinnedMesh(smootherCandidate!, model.skinMaterial);
        experimentalSurface.bind(mesh!.skeleton, mesh!.bindMatrix);
        const semanticSurface = new THREE.SkinnedMesh(semanticCandidate!, model.skinMaterial);
        semanticSurface.bind(mesh!.skeleton, mesh!.bindMatrix);
        const thumbCalibratedSurface = new THREE.SkinnedMesh(thumbCalibratedCandidate!, model.skinMaterial);
        thumbCalibratedSurface.bind(mesh!.skeleton, mesh!.bindMatrix);
        const partialThumbSurfaces = partialThumbCandidates.map(({ strength, geometry }) => {
          const candidateMesh = new THREE.SkinnedMesh(geometry, model.skinMaterial);
          candidateMesh.bind(mesh!.skeleton, mesh!.bindMatrix);
          return { strength, mesh: candidateMesh };
        });
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
            let webxrMesh: THREE.SkinnedMesh | undefined;
            referenceMotion.group.traverse(node => {
              if (node instanceof THREE.SkinnedMesh) webxrMesh = node;
            });
            expect(webxrMesh).toBeDefined();
            const webxrDeformation = measureTestingHandDeformation(webxrMesh!);
            const smoothedDeformation = measureTestingHandDeformation(experimentalSurface);
            const semanticDeformation = measureTestingHandDeformation(semanticSurface);
            const thumbCalibratedDeformation = measureTestingHandDeformation(thumbCalibratedSurface);
            // Compare EXACTLY the same triangles, selected by the native
            // anatomical thumb labels, not the candidate WebXR weight map.
            const baselineThumb = measureTestingFixedThumbRegion(
              mesh!, thumbAnatomySource!, thumbAnatomyNames,
            );
            const calibratedThumb = measureTestingFixedThumbRegion(
              thumbCalibratedSurface, thumbAnatomySource!, thumbAnatomyNames,
            );
            expect(calibratedThumb.inspectedTriangles).toBe(baselineThumb.inspectedTriangles);
            console.info("[Testing fixed native-thumb triangle A/B]", side, "hover=" + hover,
              JSON.stringify({
                baseline: baselineThumb,
                calibrated: calibratedThumb,
                baselineGlobal: { edgeStretchP95: deformation.edgeStretchP95,
                  areaRatioP95: deformation.areaRatioP95 },
                calibratedGlobal: { edgeStretchP95: thumbCalibratedDeformation.edgeStretchP95,
                  areaRatioP95: thumbCalibratedDeformation.areaRatioP95 },
              }));
            const partialThumbMetrics = partialThumbSurfaces.map(sample => ({
              strength: sample.strength,
              thumb: measureTestingFixedThumbRegion(
                sample.mesh, thumbAnatomySource!, thumbAnatomyNames,
              ),
              wholeHand: (() => {
                const metrics = measureTestingHandDeformation(sample.mesh);
                return { edgeStretchP95: metrics.edgeStretchP95,
                  areaRatioP95: metrics.areaRatioP95 };
              })(),
            }));
            for (const sample of partialThumbMetrics) {
              expect(sample.thumb.inspectedTriangles).toBe(baselineThumb.inspectedTriangles);
            }
            console.info("[Testing partial thumb calibration sweep]", side, "hover=" + hover,
              JSON.stringify({ baseline: baselineThumb, partial: partialThumbMetrics,
                full: calibratedThumb }));
            console.info("[Testing vs WebXR skinned triangle deformation]", side, "hover=" + hover,
              JSON.stringify({ testing: deformation, smoothed: smoothedDeformation,
                semantic: semanticDeformation, thumbCalibrated: thumbCalibratedDeformation,
                webxr: webxrDeformation }));
            if (hover === 0) {
              const location = locateTestingHandDeformationHotspots(mesh!, side, 12);
              const severeBones = location.bones.filter(row =>
                row.flattenedBelowQuarterArea + row.stretchedAboveDoubleArea > 0);
              console.info("[Testing joint-localized deformation hotspots]", side, JSON.stringify({
                triangles: location.trianglesInspected,
                worstTriangles: location.hotspots.map(row => ({
                  triangle: row.triangle, joint: row.dominantBone,
                  areaRatio: Number(row.areaRatio.toFixed(5)),
                  centroid: row.centroidInches.map(value => Number(value.toFixed(3))),
                })),
                mostAffectedBones: severeBones.slice(0, 15),
              }));
              expect(location.trianglesInspected).toBe(deformation.inspectedTriangles);
              expect(location.hotspots.length).toBe(12);
              expect(location.hotspots[0]!.deformationSeverity).toBeGreaterThanOrEqual(
                location.hotspots[11]!.deformationSeverity);
            }
            expect(smoothedDeformation.inspectedTriangles).toBe(deformation.inspectedTriangles);
            expect(webxrDeformation.inspectedTriangles).toBeGreaterThan(0);
            expect(deformation.inspectedTriangles).toBeGreaterThan(7000);
            expect(deformation.edgeCompressionMin).toBeGreaterThan(0);
            expect(deformation.edgeStretchMax).toBeLessThan(100);
            expect(deformation.areaRatioMin).toBeGreaterThan(0);
            expect(deformation.areaRatioMax).toBeLessThan(100);
          }
        } finally {
          referenceMotion.dispose();
          experimentalSurface.geometry.dispose();
          semanticSurface.geometry.dispose();
          thumbCalibratedSurface.geometry.dispose();
          for (const sample of partialThumbSurfaces) sample.mesh.geometry.dispose();
          thumbAnatomySource?.dispose();
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

        // Live A/B contract: original Testing -> partial thumb calibration ->
        // exactly the same original. Real LOD2 assets, both hands. Never alter
        // source mesh positions, webxr bone bind pose, or saved GLB.
        const loadedTestingMesh = () => {
          let found: THREE.SkinnedMesh | null = null;
          model.group.traverse(node => {
            if (node instanceof THREE.SkinnedMesh && node.geometry.userData.testingWebxrSkinTransfer) {
              found = node;
            }
          });
          expect(found).not.toBeNull();
          return found! as THREE.SkinnedMesh;
        };
        const original = loadedTestingMesh();
        const basePosition = Array.from(original.geometry.getAttribute("position").array);
        const baseIndices = Array.from(original.geometry.getAttribute("skinIndex").array);
        const baseWeights = Array.from(original.geometry.getAttribute("skinWeight").array);
        // Capture the actively posed WebXR bones here, not the rest-pose
        // sourceBones captured at the start of the test. An earlier section
        // already played two MotionPoses, so comparing to rest gives a false
        // regression even when the calibration preserves bone motion.
        const beforeAB = new Map(
          IMPROVED_HAND_JOINT_NAMES.map(name => {
            const bone = model.getBone(name)!;
            return [name, {
              position: bone.position.clone(),
              rotation: bone.quaternion.clone(),
            }] as const;
          }),
        );
        const assertSameWebxrPose = () => {
          for (const [name, pose] of beforeAB) {
            const bone = model.getBone(name)!;
            expect(bone.position.distanceTo(pose.position), side + " " + name).toBeLessThan(1e-5);
            expect(Math.abs(bone.quaternion.dot(pose.rotation)), side + " " + name)
              .toBeGreaterThan(1 - 1e-5);
          }
        };

        model.setTestingThumbStrength(0.25);
        await model.waitForHandModelReady();
        const partial = loadedTestingMesh();
        expect(partial.geometry.userData.testingBoneFrameTransfer).toBe(true);
        expect(partial.geometry.userData.testingBoneFrameMapping).toMatchObject({
          thumbAxialStrength: 0.25,
        });
        expect(Array.from(partial.geometry.getAttribute("position").array)).toEqual(basePosition);
        expect(partial.skeleton.bones).toHaveLength(25);
        assertSameWebxrPose();
        const partialWeights = Array.from(partial.geometry.getAttribute("skinWeight").array);
        const partialIndices = Array.from(partial.geometry.getAttribute("skinIndex").array);
        expect(partialWeights.some((value, index) =>
          Math.abs(value - baseWeights[index]!) > 1e-5 ||
          partialIndices[index] !== baseIndices[index])).toBe(true);
        expect(partial.geometry.userData.testingBoneFrameMapping)
          .toHaveProperty("thumbOnlyAffectedVertices");
        expect(untouchedNonThumb).not.toBeNull();
        let verified = 0;
        for (let vertex = 0; vertex < untouchedNonThumb!.length; vertex++) {
          if (!untouchedNonThumb![vertex]) continue;
          verified++;
          for (let slot = 0; slot < 4; slot++) {
            const offset = vertex * 4 + slot;
            expect(partialIndices[offset], side + " non-thumb skinIndex " + vertex)
              .toBe(baseIndices[offset]);
            expect(partialWeights[offset], side + " non-thumb skinWeight " + vertex)
              .toBe(baseWeights[offset]);
          }
        }
        expect(verified).toBeGreaterThan(1000);

        model.setTestingThumbStrength(0);
        await model.waitForHandModelReady();
        const restored = loadedTestingMesh();
        expect(restored.geometry.userData.testingBoneFrameTransfer).not.toBe(true);
        expect(Array.from(restored.geometry.getAttribute("position").array)).toEqual(basePosition);
        expect(Array.from(restored.geometry.getAttribute("skinIndex").array)).toEqual(baseIndices);
        expect(Array.from(restored.geometry.getAttribute("skinWeight").array)).toEqual(baseWeights);
        assertSameWebxrPose();

        // Regression: real Testing LOD2 needs a measurable pad-versus-key
        // response, not merely identical WebXR bones and complete skin weights.
        // The synthetic planar key is based on the observed pressed pad point,
        // so both thumb and index are tested for vertical penetration while
        // maintaining a small sideways (X) key-center offset.
        const playingPose = makeWebxrComparisonPose(side);
        const actualPad = (skinnedMesh: THREE.SkinnedMesh, vertex: number) => {
          skinnedMesh.updateMatrixWorld(true);
          skinnedMesh.skeleton.update();
          const p = new THREE.Vector3().fromBufferAttribute(
            skinnedMesh.geometry.getAttribute("position"), vertex,
          );
          skinnedMesh.applyBoneTransform(vertex, p);
          return p.applyMatrix4(skinnedMesh.matrixWorld);
        };
        for (const finger of [1, 2] as const) {
          model.setTestingKeyContact(false);
          model.updateFromPose(playingPose, DEFAULT_SKIN_SETTINGS, false, 0);
          const beforeMesh = loadedTestingMesh();
          const samples = beforeMesh.geometry.userData
            .testingContactSupportVertexIndicesByFinger as number[][];
          expect(samples[finger]?.length).toBeGreaterThan(0);
          const beforeSample = samples[finger]!
            .map(vertex => ({ vertex, point: actualPad(beforeMesh, vertex) }))
            .sort((a, b) => a.point.y - b.point.y)[0]!;
          const prefix = finger === 1 ? "thumb" : "index-finger";
          const tipName = prefix + "-tip";
          const uncorrectedTip = model.getBone(tipName)!.position.clone();
          const y = beforeSample.point.y + 0.12;
          const x = beforeSample.point.x + 0.10;
          const z = beforeSample.point.z;
          const target: ImprovedHandContactTarget = {
            finger, pitch: 60 + finger,
            sourceStartSeconds: 0.5,
            contactCenterX: x, contactMinX: x - 0.45,
            contactMaxX: x + 0.45, contactMinZ: z - 0.45,
            contactMaxZ: z + 0.45,
            sampleSurfaceYAt: (_pitch, px, pz) =>
              Math.abs(px - x) <= 0.45 && Math.abs(pz - z) <= 0.45 ? y : null,
          };
          model.setTestingKeyContact(true);
          model.updateFromPose(playingPose, DEFAULT_SKIN_SETTINGS, false, 0, [target]);
          const correctedTip = model.getBone(tipName)!.position;
          const afterSample = actualPad(loadedTestingMesh(), beforeSample.vertex);
          expect(correctedTip.distanceTo(uncorrectedTip), side + " finger " + finger)
            .toBeGreaterThan(1e-4);
          console.info("[Testing key contact A/B]", JSON.stringify({
            side, finger,
            before: [beforeSample.point.x, beforeSample.point.y, beforeSample.point.z],
            target: [x, y, z],
            after: [afterSample.x, afterSample.y, afterSample.z],
          }));
          expect(Math.abs(afterSample.y - y), side + " finger " + finger + " depth")
            .toBeLessThan(Math.abs(beforeSample.point.y - y));
          expect(Math.abs(afterSample.x - x), side + " finger " + finger + " lateral contact")
            .toBeLessThan(Math.abs(beforeSample.point.x - x));
          // Turning the correction off must recover the same uncorrected pose.
          model.setTestingKeyContact(false);
          expect(model.getBone(tipName)!.position.distanceTo(uncorrectedTip))
            .toBeLessThan(1e-5);
        }
      } finally {
        model.dispose();
        textures.baseColor.dispose();
        textures.normal.dispose();
        textures.roughness.dispose();
      }
      expect(leaseReleases).toBe(6);
    }
  }, 30_000); // Two real hands, all LODs and multiple async A/B mesh rebuilds.
});
