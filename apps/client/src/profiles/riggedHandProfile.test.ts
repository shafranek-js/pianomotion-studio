import { beforeEach, describe, expect, it } from "vitest";
import { hands } from "@handthesia/engine-ts";
import {
  getActiveProfile,
  listProfiles,
  resetProfileStore,
  setProfileStorage,
} from "./profileStore.ts";
import { getDefaultProfile } from "./defaultProfiles.ts";
import { ANATOMY_BONES, PianistProfileSchema } from "./types.ts";
import {
  createRiggedHandProfile,
  RIGGED_HAND_PROFILE_PROVENANCE,
} from "./riggedHandProfile.ts";

class MockStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("rigged experimental hand profile", () => {
  beforeEach(() => {
    setProfileStorage(new MockStorage());
    resetProfileStore();
  });

  it("saves a schema-valid unique Default copy without replacing or activating a profile", async () => {
    const existing = listProfiles();
    const activeBefore = getActiveProfile();

    const created = await createRiggedHandProfile();

    expect(PianistProfileSchema.safeParse(created).success).toBe(true);
    expect(created.name).toBe("Rigged hands — measured baseline");
    expect(created.profileId).not.toBe("default");
    expect(created.revision).toBe(0);
    expect(listProfiles()).toHaveLength(existing.length + 1);
    expect(new Set(listProfiles().map((profile) => profile.profileId)).size).toBe(existing.length + 1);
    for (const profile of existing) {
      expect(listProfiles().find((saved) => saved.profileId === profile.profileId)).toEqual(profile);
    }
    expect(getActiveProfile()).toEqual(activeBefore);
  });

  it("applies the exact mapped long-finger bone measurements in HandGeometry units", async () => {
    const created = await createRiggedHandProfile();
    const { source, conversion, measurements } = RIGGED_HAND_PROFILE_PROVENANCE;

    expect(source.glbSha256).toEqual({
      left: "7ce76e5d5f6279d0ac63fe07da062e040ad018670ba827381735b7c18f832dfe",
      right: "1ca11afc819b6811e1dc0ac8b4984fca17aa9408d3ed25a5910309f41a2a3881",
    });
    expect(conversion.inchesPerProfileUnit).toBe(hands.INCHES_PER_UNIT);
    expect(measurements).toHaveLength(12);
    expect(measurements.map(({ anatomyKey, bone }) => [anatomyKey, bone])).toEqual([
      ["pp2", "Bone"], ["mp2", "Bone.001"], ["dp2", "Bone.002"],
      ["pp3", "Bone.003"], ["mp3", "Bone.004"], ["dp3", "Bone.005"],
      ["pp4", "Bone.006"], ["mp4", "Bone.007"], ["dp4", "Bone.008"],
      ["pp5", "Bone.009"], ["mp5", "Bone.010"], ["dp5", "Bone.011"],
    ]);

    const expectedSourceMeters = [
      [0.126316205, 0.126316205], [0.101073019, 0.10107296], [0.089823738, 0.089823693],
      [0.150423855, 0.15042384], [0.112109311, 0.112109311], [0.093916826, 0.093916826],
      [0.130892813, 0.130892813], [0.104668319, 0.104668438], [0.095293611, 0.0952935],
      [0.126155809, 0.126155809], [0.073296927, 0.073296927], [0.073491417, 0.073491365],
    ];
    const sourceScale = { left: 0.219315506, right: 0.219315291 };

    measurements.forEach((measurement, index) => {
      const [leftMeters, rightMeters] = expectedSourceMeters[index]!;
      expect(measurement.leftMeters).toBe(leftMeters);
      expect(measurement.rightMeters).toBe(rightMeters);
      expect(measurement.meanSourceMeters).toBeCloseTo((leftMeters + rightMeters) / 2, 12);

      const expectedLeft = leftMeters * sourceScale.left * conversion.metersToInches / hands.INCHES_PER_UNIT;
      const expectedRight = rightMeters * sourceScale.right * conversion.metersToInches / hands.INCHES_PER_UNIT;
      const expectedMean = (expectedLeft + expectedRight) / 2;
      expect(measurement.leftProfileUnits).toBeCloseTo(expectedLeft, 12);
      expect(measurement.rightProfileUnits).toBeCloseTo(expectedRight, 12);
      expect(measurement.meanProfileUnits).toBeCloseTo(expectedMean, 12);
      expect(measurement.appliedToProfile).toBe(true);
      expect(measurement.fallbackReason).toBeNull();
      expect(created.anatomy[measurement.anatomyKey]).toBeCloseTo(expectedMean, 12);

      const definition = ANATOMY_BONES.find((bone) => bone.id === measurement.anatomyKey)!;
      expect(expectedMean).toBeGreaterThanOrEqual(definition.min);
      expect(expectedMean).toBeLessThanOrEqual(definition.max);
    });

    const defaultProfile = getDefaultProfile();
    for (const bone of ANATOMY_BONES) {
      if (!measurements.some((measurement) => measurement.anatomyKey === bone.id)) {
        expect(created.anatomy[bone.id]).toBe(defaultProfile.anatomy[bone.id]);
      }
    }
    expect(created.anatomy.wrist).toBe(defaultProfile.anatomy.wrist);
    expect(created.behavior).toEqual(defaultProfile.behavior);
    expect(created.skin).toEqual(defaultProfile.skin);
  });

  it("returns independent deep copies for repeated creations", async () => {
    const first = await createRiggedHandProfile();
    const second = await createRiggedHandProfile();
    const defaultProfile = getDefaultProfile();
    const firstSavedBeforeMutation = listProfiles().find((profile) => profile.profileId === first.profileId)!;

    expect(first.profileId).not.toBe(second.profileId);
    expect(first.anatomy).not.toBe(second.anatomy);
    expect(first.behavior).not.toBe(second.behavior);
    expect(first.skin).not.toBe(second.skin);
    expect(first.colorRgb).not.toBe(second.colorRgb);

    first.anatomy.pp2 += 1;
    first.colorRgb[0] = 0;
    const mutableSkin = first.skin as { colors: { skeleton: { bone: number[] } } };
    mutableSkin.colors.skeleton.bone[0] = 255;

    expect(second.anatomy.pp2).toBe(firstSavedBeforeMutation.anatomy.pp2);
    expect(defaultProfile.anatomy.pp2).not.toBe(first.anatomy.pp2);
    expect(second.colorRgb[0]).not.toBe(0);
    expect((second.skin as { colors: { skeleton: { bone: number[] } } }).colors.skeleton.bone[0]).not.toBe(255);
    expect(listProfiles().find((profile) => profile.profileId === first.profileId)).toEqual(firstSavedBeforeMutation);
  });
});
