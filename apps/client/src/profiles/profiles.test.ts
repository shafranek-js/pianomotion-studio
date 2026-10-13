import { describe, it, expect, beforeEach } from "vitest";
import {
  PianistProfileSchema,
  DEFAULT_PROFILE,
  SMALL_HANDS_PROFILE,
  VIRTUOSO_PROFILE,
  LEFT_DOMINANT_PROFILE,
  getDefaultProfiles,
  getDefaultProfile,
  ANATOMY_BONES,
  BEHAVIOR_SLIDERS,
  BEHAVIOR_OPTIONS,
  DEFAULT_ANATOMY,
  DEFAULT_BEHAVIOR,
  importLegacyPianistJson,
  exportProfileToJson,
  getActiveProfile,
  setActiveProfile,
  listProfiles,
  saveProfile,
  deleteProfile,
  cloneProfile,
  subscribe,
  resetProfileStore,
  setProfileStorage,
} from "./index.ts";

const DESKTOP_DEFAULT_COPY_JSON = JSON.stringify({
  name: "Default copy",
  color: [12, 12, 14],
  anatomy: {
    mc1: 4.7,
    pp1: 3.3,
    dp1: 2.8,
    mc2: 6.684,
    pp2: 4.0,
    mp2: 2.3,
    dp2: 1.8,
    mc3: 6.626,
    pp3: 4.5,
    mp3: 2.7,
    dp3: 1.9,
    mc4: 6.332,
    pp4: 4.2,
    mp4: 2.6,
    dp4: 1.9,
    mc5: 5.974,
    pp5: 3.3,
    mp5: 1.8,
    dp5: 1.7,
  },
  behavior: {
    retraction: 0.1,
    finger_curve: 0.4,
    antic_hand: 0.5,
    antic_fingers: 0.5,
    tendon_link: 0.6,
    cross_height: 0.33,
    lift_height: 0.5,
    wrist_bounce: 0.5,
    tremolo_rotation: 0.5,
    gesture_finger_action: 0.25,
    cross_turn: 14.0,
    smoothness: 0.07,
    early_release: 0.22,
    max_speed: 3.0,
    key_area_near: 0.0,
    key_area_far: 1.0,
    roll_speed: 0.035,
    glissando: "on",
    gliss_gap: 0.05,
    gliss_min: 6.0,
    gliss_merge: 1.0,
    fingering_model: "learned",
    weak_bias: 0.25,
    stretch_bias: 0.0,
    economy: 0.5,
    black_avoid: 0.5,
    chromatic: "13",
    repeated: "321",
    trill: "auto",
    octaves: "4black",
  },
  created: 1791886634.68,
  modified: 1791886640.25,
  skin: {
    style: "gloves",
    colors: {
      skeleton: { bone: [12, 12, 14] },
    },
    finger_width: 0.75,
  },
  weights: {},
});

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("Pianist Profiles - Types & Definitions", () => {
  it("defines all 19 anatomy bones matching desktop anatomy", () => {
    expect(ANATOMY_BONES).toHaveLength(19);

    const boneIds = ANATOMY_BONES.map((b) => b.id);
    expect(boneIds).toContain("mc1");
    expect(boneIds).toContain("pp1");
    expect(boneIds).toContain("dp1");
    // Thumb does not have middle phalanx
    expect(boneIds).not.toContain("mp1");

    for (let f = 2; f <= 5; f++) {
      expect(boneIds).toContain(`mc${f}`);
      expect(boneIds).toContain(`pp${f}`);
      expect(boneIds).toContain(`mp${f}`);
      expect(boneIds).toContain(`dp${f}`);
    }

    for (const bone of ANATOMY_BONES) {
      expect(bone.defaultLength).toBeGreaterThan(0);
      expect(bone.min).toBeLessThan(bone.defaultLength);
      expect(bone.max).toBeGreaterThan(bone.defaultLength);
    }
  });

  it("defines all behavior sliders with proper ranges and defaults", () => {
    expect(BEHAVIOR_SLIDERS.length).toBeGreaterThanOrEqual(21);
    const sliderIds = new Set(BEHAVIOR_SLIDERS.map((s) => s.id));

    const expectedKeys = [
      "retraction",
      "finger_curve",
      "antic_hand",
      "antic_fingers",
      "tendon_link",
      "cross_height",
      "lift_height",
      "wrist_bounce",
      "tremolo_rotation",
      "gesture_finger_action",
      "cross_turn",
      "smoothness",
      "early_release",
      "max_speed",
      "key_area_near",
      "key_area_far",
      "roll_speed",
      "weak_bias",
      "stretch_bias",
      "economy",
      "black_avoid",
    ];

    for (const key of expectedKeys) {
      expect((sliderIds as Set<string>).has(key)).toBe(true);
    }

    for (const slider of BEHAVIOR_SLIDERS) {
      expect(slider.min).toBeLessThanOrEqual(slider.default);
      expect(slider.max).toBeGreaterThanOrEqual(slider.default);
      expect(slider.label.length).toBeGreaterThan(0);
    }
  });

  it("defines all behavior options with choices", () => {
    expect(BEHAVIOR_OPTIONS).toHaveLength(6);
    const optionIds = new Set(BEHAVIOR_OPTIONS.map((o) => o.id));

    expect(optionIds.has("glissando")).toBe(true);
    expect(optionIds.has("fingering_model")).toBe(true);
    expect(optionIds.has("chromatic")).toBe(true);
    expect(optionIds.has("repeated")).toBe(true);
    expect(optionIds.has("trill")).toBe(true);
    expect(optionIds.has("octaves")).toBe(true);

    const gliss = BEHAVIOR_OPTIONS.find((o) => o.id === "glissando")!;
    expect(gliss.options.map((c) => c.value)).toEqual(["on", "off"]);

    const model = BEHAVIOR_OPTIONS.find((o) => o.id === "fingering_model")!;
    expect(model.options.map((c) => c.value)).toEqual(["learned", "textbook"]);
  });
});

describe("Canonical Default Profiles", () => {
  it("all built-in profiles strictly satisfy PianistProfileSchema", () => {
    const defaults = getDefaultProfiles();
    expect(defaults).toHaveLength(4);

    for (const profile of defaults) {
      const parsed = PianistProfileSchema.safeParse(profile);
      expect(parsed.success).toBe(true);
      expect(profile.schemaVersion).toBe(1);
      expect(profile.revision).toBe(0);
      expect(profile.createdAtUnixSeconds).toBeGreaterThanOrEqual(0);
      expect(profile.modifiedAtUnixSeconds).toBeGreaterThanOrEqual(
        profile.createdAtUnixSeconds
      );
      expect(profile.colorRgb).toHaveLength(3);
      for (const val of Object.values(profile.anatomy)) {
        expect(val).toBeGreaterThan(0);
      }
    }
  });

  it("getDefaultProfile returns deep clone of default profile", () => {
    const def1 = getDefaultProfile();
    const def2 = getDefaultProfile();
    expect(def1.profileId).toBe("default");
    expect(def1.name).toBe("Default copy");
    expect(def1).not.toBe(def2);
    expect(def1).toEqual(def2);
  });

  it("exhibits anatomical and behavioral differences between Small Hands and Virtuoso", () => {
    // Small Hands
    expect(SMALL_HANDS_PROFILE.profileId).toBe("small-hands");
    expect(SMALL_HANDS_PROFILE.behavior.stretch_bias).toBe(-0.4);
    expect(SMALL_HANDS_PROFILE.behavior.weak_bias).toBe(0.4);
    expect(SMALL_HANDS_PROFILE.behavior.max_speed).toBe(2.2);

    // Virtuoso
    expect(VIRTUOSO_PROFILE.profileId).toBe("virtuoso");
    expect(VIRTUOSO_PROFILE.behavior.stretch_bias).toBe(0.7);
    expect(VIRTUOSO_PROFILE.behavior.weak_bias).toBe(0.15);
    expect(VIRTUOSO_PROFILE.behavior.max_speed).toBe(4.5);
    expect(VIRTUOSO_PROFILE.behavior.early_release).toBe(0.15);

    // Anatomy comparison: Small Hands < Default < Virtuoso
    for (const bone of ANATOMY_BONES) {
      const smallLen = SMALL_HANDS_PROFILE.anatomy[bone.id];
      const defaultLen = DEFAULT_PROFILE.anatomy[bone.id];
      const virtuosoLen = VIRTUOSO_PROFILE.anatomy[bone.id];

      expect(smallLen).toBeLessThan(defaultLen);
      expect(virtuosoLen).toBeGreaterThan(defaultLen);

      // Verify ratios: small hands ~ 0.8x (between 0.75x and 0.85x), virtuoso ~ 1.25x
      const smallRatio = smallLen / defaultLen;
      expect(smallRatio).toBeGreaterThanOrEqual(0.75);
      expect(smallRatio).toBeLessThanOrEqual(0.85);

      const virtuosoRatio = virtuosoLen / defaultLen;
      expect(virtuosoRatio).toBeCloseTo(1.25, 4);
    }
  });

  it("configures Left Dominant profile with left dominance preference", () => {
    expect(LEFT_DOMINANT_PROFILE.profileId).toBe("left-dominant");
    expect(LEFT_DOMINANT_PROFILE.behavior.left_dominant).toBe(true);
    expect(LEFT_DOMINANT_PROFILE.behavior.hand_dominance).toBe("left");
  });
});

describe("Legacy JSON Importer & Exporter", () => {
  it("parses desktop default-copy.json fixture correctly", () => {
    const imported = importLegacyPianistJson(DESKTOP_DEFAULT_COPY_JSON);

    expect(imported.schemaVersion).toBe(1);
    expect(imported.profileId).toBe("default-copy");
    expect(imported.name).toBe("Default copy");
    expect(imported.colorRgb).toEqual([12, 12, 14]);
    expect(imported.revision).toBe(0);
    expect(imported.createdAtUnixSeconds).toBeCloseTo(1791886634.68, 1);
    expect(imported.modifiedAtUnixSeconds).toBeCloseTo(1791886640.25, 1);

    // Check anatomy values match desktop
    expect(imported.anatomy.mc1).toBe(4.7);
    expect(imported.anatomy.pp1).toBe(3.3);
    expect(imported.anatomy.dp1).toBe(2.8);
    expect(imported.anatomy.mc2).toBe(6.684);

    // Check behaviors match desktop
    expect(imported.behavior.retraction).toBe(0.1);
    expect(imported.behavior.finger_curve).toBe(0.4);
    expect(imported.behavior.antic_hand).toBe(0.5);
    expect(imported.behavior.max_speed).toBe(3.0);
    expect(imported.behavior.glissando).toBe("on");
    expect(imported.behavior.fingering_model).toBe("learned");
    expect(imported.behavior.chromatic).toBe("13");
    expect(imported.behavior.octaves).toBe("4black");

    const parsed = PianistProfileSchema.safeParse(imported);
    expect(parsed.success).toBe(true);
  });

  it("fills defaults for missing anatomy, behavior, and color properties", () => {
    const minimalJson = JSON.stringify({
      name: "Minimalist Pianist",
    });

    const imported = importLegacyPianistJson(minimalJson);

    expect(imported.name).toBe("Minimalist Pianist");
    expect(imported.profileId).toBe("minimalist-pianist");
    expect(imported.schemaVersion).toBe(1);
    expect(imported.revision).toBe(0);
    expect(imported.colorRgb).toEqual([12, 12, 14]);

    // Check default anatomy was filled
    for (const [key, val] of Object.entries(DEFAULT_ANATOMY)) {
      expect(imported.anatomy[key]).toBe(val);
    }
    expect(imported.anatomy.wrist).toBe(1.0);

    // Check default behavior was filled
    for (const [key, val] of Object.entries(DEFAULT_BEHAVIOR)) {
      expect(imported.behavior[key]).toBe(val);
    }

    expect(PianistProfileSchema.safeParse(imported).success).toBe(true);
  });

  it("throws descriptive errors for invalid JSON or empty input", () => {
    expect(() => importLegacyPianistJson("")).toThrow(/empty/i);
    expect(() => importLegacyPianistJson("   ")).toThrow(/empty/i);
    expect(() => importLegacyPianistJson("{ invalid json }")).toThrow(
      /Failed to parse legacy profile JSON/i
    );
    expect(() => importLegacyPianistJson('"string only"')).toThrow(/object/i);
    expect(() => importLegacyPianistJson("[1, 2, 3]")).toThrow(/object/i);
  });

  it("throws descriptive errors for empty or prohibited names", () => {
    expect(() => importLegacyPianistJson(JSON.stringify({}))).toThrow(
      /'name' is required/i
    );
    expect(() => importLegacyPianistJson(JSON.stringify({ name: "" }))).toThrow(
      /'name' is required/i
    );
    expect(() =>
      importLegacyPianistJson(JSON.stringify({ name: "   " }))
    ).toThrow(/'name' is required/i);
    expect(() =>
      importLegacyPianistJson(JSON.stringify({ name: "__proto__" }))
    ).toThrow(/prohibited/i);
    expect(() =>
      importLegacyPianistJson(JSON.stringify({ name: "constructor" }))
    ).toThrow(/prohibited/i);
  });

  it("throws descriptive errors for non-positive or non-number bone lengths", () => {
    expect(() =>
      importLegacyPianistJson(
        JSON.stringify({
          name: "Zero Bone",
          anatomy: { mc1: 0 },
        })
      )
    ).toThrow(/positive number/i);

    expect(() =>
      importLegacyPianistJson(
        JSON.stringify({
          name: "Negative Bone",
          anatomy: { pp2: -2.5 },
        })
      )
    ).toThrow(/positive number/i);

    expect(() =>
      importLegacyPianistJson(
        JSON.stringify({
          name: "NaN Bone",
          anatomy: { dp1: "not-a-number" },
        })
      )
    ).toThrow(/positive number/i);
  });

  it("exports profile to formatted JSON and round-trips through importer", () => {
    const exportedJson = exportProfileToJson(DEFAULT_PROFILE);
    expect(exportedJson).toContain('  "name": "Default copy"');
    expect(exportedJson).toContain('  "schemaVersion": 1');

    const reimported = importLegacyPianistJson(exportedJson);
    expect(reimported.name).toBe(DEFAULT_PROFILE.name);
    expect(reimported.profileId).toBe(DEFAULT_PROFILE.profileId);
    expect(reimported.anatomy).toEqual(DEFAULT_PROFILE.anatomy);
    expect(reimported.behavior).toEqual(DEFAULT_PROFILE.behavior);
  });
});

describe("Profile Store", () => {
  let mockStorage: MockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    setProfileStorage(mockStorage);
    resetProfileStore();
  });

  it("initializes with built-in default profiles and active profile 'default'", () => {
    const active = getActiveProfile();
    expect(active.profileId).toBe("default");
    expect(active.name).toBe("Default copy");

    const all = listProfiles();
    expect(all).toHaveLength(4);
    expect(all.map((p) => p.profileId)).toContain("default");
    expect(all.map((p) => p.profileId)).toContain("small-hands");
    expect(all.map((p) => p.profileId)).toContain("virtuoso");
    expect(all.map((p) => p.profileId)).toContain("left-dominant");
  });

  it("switches active profile with setActiveProfile and throws for non-existent id", async () => {
    await setActiveProfile("small-hands");
    expect(getActiveProfile().profileId).toBe("small-hands");

    await setActiveProfile("virtuoso");
    expect(getActiveProfile().profileId).toBe("virtuoso");

    await expect(setActiveProfile("non-existent-id")).rejects.toThrow(/Profile not found/i);
  });

  it("clones a profile with unique id and saves it", async () => {
    const cloned = await cloneProfile("default", "My Custom Pianist");
    expect(cloned.name).toBe("My Custom Pianist");
    expect(cloned.profileId).toBe("my-custom-pianist");
    expect(cloned.revision).toBe(0);

    const all = listProfiles();
    expect(all.some((p) => p.profileId === "my-custom-pianist")).toBe(true);

    // Cloning with same name yields deduplicated id
    const clonedAgain = await cloneProfile("default", "My Custom Pianist");
    expect(clonedAgain.profileId).toBe("my-custom-pianist-1");

    // Cloning invalid id throws
    await expect(cloneProfile("does-not-exist", "Test")).rejects.toThrow(/source profile 'does-not-exist' not found/i);

    // Cloning with empty name throws
    await expect(cloneProfile("default", "   ")).rejects.toThrow(/newName must be a non-empty string/i);
  });

  it("saves existing profile, increments revision, and updates modified timestamp", async () => {
    const profile = getActiveProfile();
    const originalRevision = profile.revision;

    profile.behavior.max_speed = 3.8;
    const committed = await saveProfile(profile);

    const updated = getActiveProfile();
    expect(updated.behavior.max_speed).toBe(3.8);
    expect(updated.revision).toBeGreaterThan(originalRevision);
    expect(committed.revision).toBe(updated.revision);
    expect(updated.modifiedAtUnixSeconds).toBeGreaterThanOrEqual(
      profile.createdAtUnixSeconds
    );
  });

  it("prevents deletion of canonical profiles", async () => {
    const deleted = await deleteProfile("default");
    expect(deleted).toBe(false);
    expect(await deleteProfile("small-hands")).toBe(false);

    const active = getActiveProfile();
    expect(active.profileId).toBe("default");
    expect(listProfiles().some((p) => p.profileId === "default")).toBe(true);
  });

  it("deletes user profile and reverts active profile to default if active was deleted", async () => {
    const custom = await cloneProfile("default", "Temporary Profile");
    expect(listProfiles().some((p) => p.profileId === custom.profileId)).toBe(
      true
    );

    await setActiveProfile(custom.profileId);
    expect(getActiveProfile().profileId).toBe(custom.profileId);

    const deleted = await deleteProfile(custom.profileId);
    expect(deleted).toBe(true);

    expect(listProfiles().some((p) => p.profileId === custom.profileId)).toBe(
      false
    );
    expect(getActiveProfile().profileId).toBe("default");

    // Deleting non-existent profile returns false
    expect(await deleteProfile("non-existent")).toBe(false);
  });

  it("notifies subscribers on profile changes and allows unsubscribe", async () => {
    let callCount = 0;
    const unsubscribe = subscribe(() => {
      callCount++;
    });

    await setActiveProfile("small-hands");
    expect(callCount).toBe(1);

    await cloneProfile("default", "Subscribed Pianist");
    expect(callCount).toBe(2);

    unsubscribe();
    await setActiveProfile("virtuoso");
    expect(callCount).toBe(2);
  });

  it("persists and restores legacy state from storage", async () => {
    await setActiveProfile("small-hands");
    await cloneProfile("small-hands", "Persisted Profile");

    // Reset in-memory cache without wiping storage
    // By re-creating store without clearing storage
    setProfileStorage(mockStorage);

    const active = getActiveProfile();
    expect(active.profileId).toBe("small-hands");

    const profiles = listProfiles();
    expect(profiles.some((p) => p.name === "Persisted Profile")).toBe(true);
  });
});
