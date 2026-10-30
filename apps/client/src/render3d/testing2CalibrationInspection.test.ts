// @ts-expect-error Vitest runs this checked-in asset test in Node; Node types are excluded from app source compilation.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ImprovedHandAsset, ImprovedHandAssetLoader } from "./improvedHandAssets";
import {
  inspectTesting2Measurements,
} from "./testing2CalibrationInspection";
import type { Testing2CalibrationHand } from "./testing2ProfileCalibration";

const manifestUrl = new URL("../../public/models/hands/improved/manifest.json", import.meta.url);
const improvedModelsUrl = new URL("../../public/models/hands/improved/", import.meta.url);

type FixtureLod = {
  url: string;
  landmarks: Record<string, [number, number, number]>;
};

type FixtureManifest = {
  hands: Record<Testing2CalibrationHand, { lods: FixtureLod[] }>;
};

describe("Testing2 paired measurement inspection", () => {
  it("loads LOD 0 for both hands and returns separate report-only estimates", async () => {
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as FixtureManifest;
    const calls: Array<{ hand: Testing2CalibrationHand; level: 0 }> = [];
    const loader = {
      load: async (hand: Testing2CalibrationHand, level: 0) => {
        calls.push({ hand, level });
        const fixture = manifest.hands[hand].lods[level]!;
        const asset = {
          hand,
          lod: fixture,
        } as unknown as ImprovedHandAsset;
        return asset;
      },
    } as Pick<ImprovedHandAssetLoader, "load">;

    const inspection = await inspectTesting2Measurements(loader);

    expect(calls).toEqual([{ hand: "left", level: 0 }, { hand: "right", level: 0 }]);
    expect(inspection.left.hand).toBe("left");
    expect(inspection.right.hand).toBe("right");
    expect(inspection.left.measurements).toHaveLength(19);
    expect(inspection.right.measurements).toHaveLength(19);
    expect(inspection.left.profileDtoCreated).toBe(true);
    expect(inspection.right.profileDtoCreated).toBe(true);
    expect(inspection.left.measurements.every((item) => item.appliedToProfile === false)).toBe(true);
    expect(inspection.right.measurements.every((item) => item.appliedToProfile === false)).toBe(true);
  });

  it("returns a clear error when a loaded LOD does not provide landmarks", async () => {
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as FixtureManifest;
    const loader = {
      load: async (hand: Testing2CalibrationHand) => ({
        hand,
        lod: hand === "left" ? manifest.hands.left.lods[0] : { url: "right-lod0.glb" },
      } as unknown as ImprovedHandAsset),
    } as Pick<ImprovedHandAssetLoader, "load">;

    await expect(inspectTesting2Measurements(loader)).rejects.toThrow(
      "The improved right-hand LOD has no named calibration landmarks.",
    );
  });

  it("uses the real checked-in LOD URLs named by the manifest", () => {
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as FixtureManifest;
    for (const hand of ["left", "right"] as const) {
      const lod = manifest.hands[hand].lods[0]!;
      expect(readFileSync(new URL(lod.url, improvedModelsUrl)).byteLength).toBeGreaterThan(20);
      expect(lod.landmarks).toBeDefined();
    }
  });
});
