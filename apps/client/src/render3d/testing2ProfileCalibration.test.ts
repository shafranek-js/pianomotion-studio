// @ts-expect-error Vitest runs this checked-in asset conformance test in Node; Node types are excluded from app source compilation.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../profiles/defaultProfiles";
import {
  calibrateTesting2Profile,
  TESTING2_SOURCE_LANDMARK_NAMES,
  type Testing2CalibrationHand,
  type Testing2SourceHandPositions,
} from "./testing2ProfileCalibration";

const manifestUrl = new URL("../../public/models/hands/improved/manifest.json", import.meta.url);
const improvedModelsUrl = new URL("../../public/models/hands/improved/", import.meta.url);

type FixtureLod = {
  url: string;
  landmarks: Record<string, [number, number, number]>;
};

type FixtureManifest = {
  hands: Record<Testing2CalibrationHand, { lods: FixtureLod[] }>;
};

function readManifest(): FixtureManifest {
  return JSON.parse(readFileSync(manifestUrl, "utf8")) as FixtureManifest;
}

function readArrayBuffer(url: URL): ArrayBuffer {
  const bytes = readFileSync(url);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readGlbJointNames(buffer: ArrayBuffer): string[] {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) {
    throw new Error("Expected a GLB 2.0 asset.");
  }
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as {
    nodes: Array<{ name?: string }>;
    skins: Array<{ joints: number[] }>;
  };
  const names = json.skins[0]?.joints.map((nodeIndex) => json.nodes[nodeIndex]?.name ?? "");
  if (!names) throw new Error("GLB has no skin joint list.");
  return names;
}

function clonePositions(input: Record<string, [number, number, number]>): Record<string, [number, number, number]> {
  return structuredClone(input);
}

describe("Testing2 source hand profile calibration", () => {
  it("measures left and right checked-in GLB landmarks independently and creates new Default-based DTOs", () => {
    const manifest = readManifest();
    const defaultSnapshot = structuredClone(DEFAULT_PROFILE);
    const results = (Object.keys(manifest.hands) as Testing2CalibrationHand[]).map((hand) => {
      const lod = manifest.hands[hand].lods[0]!;
      const glbNames = readGlbJointNames(readArrayBuffer(new URL(lod.url, improvedModelsUrl)));
      expect(new Set(glbNames).size).toBe(25);
      expect([...glbNames].sort()).toEqual([...TESTING2_SOURCE_LANDMARK_NAMES].sort());
      expect(Object.keys(lod.landmarks).sort()).toEqual([...TESTING2_SOURCE_LANDMARK_NAMES].sort());

      const result = calibrateTesting2Profile(hand, lod.landmarks, {
        profileId: `testing2-${hand}-source-fixture`,
        name: `Testing2 source ${hand}`,
        createdAtUnixSeconds: 1_798_000_000,
      });
      expect(result.profile).not.toBeNull();
      expect(result.report.hand).toBe(hand);
      expect(result.report.provenance).toMatchObject({
        coordinateFrame: "improved GLB estimated bind/rest frame; right-handed; distances are orientation independent",
        rawSourceRigPresent: false,
        improvedRigPositionsAreEstimated: true,
        anatomicalTruthVerified: false,
      });
      expect(result.report.landmarks).toMatchObject({ requiredCount: 25, validCount: 25, missing: [], invalid: [] });
      expect(result.report.conversion).toMatchObject({
        sourceMetersPerUnit: 1,
        millimetersPerMeter: 1000,
        millimetersPerInch: 25.4,
        profileModelUnitDescription: "HandGeometry anatomy unit",
      });
      expect(result.report.conversion.engineInchesPerProfileModelUnit).toBeCloseTo(0.336980147425324, 12);
      expect(result.report.conversion.millimetersPerProfileModelUnit).toBeCloseTo(8.559296, 5);
      expect(result.report.measurements).toHaveLength(19);
      expect(result.report.measurements.every((item) => item.status === "measured")).toBe(true);
      for (const measurement of result.report.measurements) {
        expect(measurement.distanceMeters).toBeGreaterThan(0);
        expect(measurement.distanceMillimeters).toBeCloseTo(measurement.distanceMeters! * 1000, 10);
        expect(measurement.distanceInches).toBeCloseTo(measurement.distanceMillimeters! / 25.4, 10);
        expect(measurement.candidateProfileModelUnits).toBeGreaterThan(0);
        expect(measurement.defaultProfileModelUnits).toBe(DEFAULT_PROFILE.anatomy[measurement.profileKey]);
        expect(measurement.differenceFromDefaultProfileModelUnits).toBeCloseTo(
          measurement.candidateProfileModelUnits! - measurement.defaultProfileModelUnits!,
          12,
        );
        expect(measurement.appliedToProfile).toBe(false);
        expect(measurement.mappingStatus).toMatch(/^reference-only-/);
        expect(result.profile!.anatomy[measurement.profileKey]).toBe(DEFAULT_PROFILE.anatomy[measurement.profileKey]);
      }

      expect(result.profile).toMatchObject({
        profileId: `testing2-${hand}-source-fixture`,
        name: `Testing2 source ${hand}`,
        revision: 0,
        createdAtUnixSeconds: 1_798_000_000,
        modifiedAtUnixSeconds: 1_798_000_000,
      });
      expect(result.profile!.behavior).toEqual(DEFAULT_PROFILE.behavior);
      expect(result.profile!.skin).toEqual(DEFAULT_PROFILE.skin);
      expect(result.profile!.weights).toEqual(DEFAULT_PROFILE.weights);
      expect(result.profile!.anatomy.wrist).toBe(DEFAULT_PROFILE.anatomy.wrist);
      expect(result.profile!.anatomy).toEqual(DEFAULT_PROFILE.anatomy);
      expect(result.report.geometry.wristWidth).toBeNull();
      expect(result.report.persistence).toBe("proposed-only; not saved or selected");
      expect(result.report.profileDtoCreated).toBe(true);
      expect(result.report.anatomyPolicy).toContain("Default anatomy retained");
      expect(result.report.geometry.palmMcpSpan?.millimeters).toBeGreaterThan(0);
      expect(result.report.geometry.metacarpalBaseSpan?.millimeters).toBeGreaterThan(0);
      expect(result.report.geometry.independentlyRepresentablePalmWidth).toBe(false);
      expect(result.report.geometry.independentlyRepresentableMetacarpalRootPositions).toBe(false);
      expect(result.report.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
        "palm-width-not-independently-representable",
        "wrist-width-unavailable",
        "metacarpal-root-geometry-not-representable",
        "metacarpal-length-reference-only",
        "estimated-segment-not-applied",
      ]));
      expect(result.report.diagnostics.filter((item) => item.code === "metacarpal-length-reference-only")).toHaveLength(5);
      expect(result.report.diagnostics.filter((item) => item.code === "estimated-segment-not-applied")).toHaveLength(19);
      return result;
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.report.hand).not.toBe(results[1]!.report.hand);
    expect(results[0]!.profile!.profileId).not.toBe(results[1]!.profile!.profileId);
    expect(DEFAULT_PROFILE).toEqual(defaultSnapshot);
  });

  it("does not clamp measured values that exceed the profile editor range", () => {
    const manifest = readManifest();
    const positions = clonePositions(manifest.hands.left.lods[0]!.landmarks);
    for (const point of Object.values(positions)) {
      point[0] *= 100;
      point[1] *= 100;
      point[2] *= 100;
    }

    const result = calibrateTesting2Profile("left", positions, {
      profileId: "testing2-no-clamp-fixture",
      createdAtUnixSeconds: 1_798_000_000,
    });
    expect(result.profile).not.toBeNull();
    const pp1 = result.report.measurements.find((item) => item.profileKey === "pp1")!;
    expect(pp1.editableRange?.inRange).toBe(false);
    expect(pp1.candidateProfileModelUnits).toBeGreaterThan(0);
    expect(result.profile!.anatomy.pp1).toBe(DEFAULT_PROFILE.anatomy.pp1);
    expect(result.profile!.anatomy.mc1).toBe(DEFAULT_PROFILE.anatomy.mc1);
    expect(result.report.diagnostics.some((item) => item.code === "segment-outside-editor-range")).toBe(true);
  });

  it("rejects missing and non-finite landmarks and records affected segments", () => {
    const manifest = readManifest();
    const positions = clonePositions(manifest.hands.right.lods[0]!.landmarks);
    delete (positions as Partial<Record<keyof Testing2SourceHandPositions, unknown>>)["middle-finger-phalanx-intermediate"];
    (positions as Record<string, unknown>)["index-finger-phalanx-proximal"] = [0, Number.NaN, 0];

    const result = calibrateTesting2Profile("right", positions);
    expect(result.profile).toBeNull();
    expect(result.report.profileDtoCreated).toBe(false);
    expect(result.report.landmarks.missing).toContain("middle-finger-phalanx-intermediate");
    expect(result.report.landmarks.invalid).toContain("index-finger-phalanx-proximal");
    expect(result.report.measurements.find((item) => item.profileKey === "mp3")?.status).toBe("unavailable");
    expect(result.report.measurements.find((item) => item.profileKey === "mc2")?.unavailableReason).toBe("invalid-landmark-position");
    expect(result.report.diagnostics.some((item) => item.severity === "error" && item.code === "missing-landmark")).toBe(true);
    expect(result.report.diagnostics.some((item) => item.severity === "error" && item.code === "invalid-landmark-position")).toBe(true);
  });

  it("rejects zero-length segments without inventing a replacement length", () => {
    const manifest = readManifest();
    const positions = clonePositions(manifest.hands.left.lods[0]!.landmarks);
    positions["index-finger-phalanx-proximal"] = [...positions["index-finger-metacarpal"]];

    const result = calibrateTesting2Profile("left", positions, { profileId: "testing2-zero-length" });
    expect(result.profile).toBeNull();
    expect(result.report.measurements.find((item) => item.profileKey === "mc2")).toMatchObject({
      status: "unavailable",
      unavailableReason: "zero-length-segment",
    });
    expect(result.report.diagnostics.some((item) => item.code === "zero-length-segment" && item.path === "measurements.mc2")).toBe(true);
  });

  it("makes a unique ID for each proposed profile and rejects invalid profile options", () => {
    const positions = readManifest().hands.left.lods[0]!.landmarks;
    const first = calibrateTesting2Profile("left", positions, { createdAtUnixSeconds: 1_798_000_001 });
    const second = calibrateTesting2Profile("left", positions, { createdAtUnixSeconds: 1_798_000_001 });
    expect(first.profile).not.toBeNull();
    expect(second.profile).not.toBeNull();
    expect(first.profile!.profileId).not.toBe(second.profile!.profileId);

    const invalid = calibrateTesting2Profile("left", positions, { profileId: "   " });
    expect(invalid.profile).toBeNull();
    expect(invalid.report.diagnostics.some((item) => item.code === "invalid-profile-options")).toBe(true);
  });
});
