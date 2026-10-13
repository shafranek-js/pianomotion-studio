import type { MotionPlan, MotionPose } from "@handthesia/contracts";
import trackedRightHandFixture from "../../../../tests/fixtures/golden/tracked-right-hand.json";
import { describe, expect, it } from "vitest";

function createMockPlan(poses: MotionPose[]): MotionPlan {
  return {
    schemaVersion: 1,
    planId: "test-plan-id",
    projectId: "test-project-id",
    inputRevision: 1,
    profileId: "test-profile-id",
    profileRevision: 1,
    engineVersion: "1.0.0",
    diagnostics: [],
    kind: "motion",
    coordinateFrame: "keyboard-local-inches-v1",
    performancePlanId: "test-perf-id",
    poses,
  };
}
import {
  computeFingerRadius,
  computeShadowAlpha,
  computeShadowOffset,
  DEFAULT_SKIN_COLORS,
  DEFAULT_SKIN_SETTINGS,
  depthScale,
  FINGER_W_IN,
  FINGER_WIDTH_RANGE,
  HandsView,
  KeyboardLayout,
  mixRgb,
  normalizeSkinSettings,
  OUTLINE_RANGE,
  rgbToHex,
  SEG_TAPER,
  SingleHandRenderer,
  type SkinStyle,
} from "./index";
import { buildHandGeometry, chaikin, convexHull, getFingerTipsByFinger, inflate } from "./skins/geometry";

type GoldenPose = {
  hand: "L" | "R";
  layer: number;
  time: number;
  coordinateFrame: { keyboardRect: [number, number, number, number]; pixelsPerInch: number; frontY: number };
  bones: Array<{ type: MotionPose["bones"][number]["kind"]; start: [number, number, number]; end: [number, number, number] }>;
  joints: Array<{ type: MotionPose["joints"][number]["kind"]; position: [number, number, number] }>;
};

function loadTrackedRightGoldenPose(): MotionPose {
  const golden = trackedRightHandFixture as unknown as { selectedPoses: GoldenPose[] };
  const pose = golden.selectedPoses[0]!;
  const frame = pose.coordinateFrame;
  const keyboardLeft = frame.keyboardRect[0];
  const toKeyboardInches = (point: [number, number, number]): [number, number, number] => [
    (point[0] - keyboardLeft) / frame.pixelsPerInch,
    point[1] / frame.pixelsPerInch,
    point[2] / frame.pixelsPerInch,
  ];
  return {
    hand: pose.hand === "L" ? "left" : "right",
    transportTimeSeconds: pose.time,
    layerOrder: pose.layer,
    bones: pose.bones.map((bone) => ({
      a: toKeyboardInches(bone.start),
      b: toKeyboardInches(bone.end),
      kind: bone.type,
    })),
    joints: pose.joints.map((joint) => ({
      point: toKeyboardInches(joint.position),
      kind: joint.type,
    })),
  };
}

function createMockPose(hand: "left" | "right", layerOrder = 0): MotionPose {
  // A representative anatomical hand pose with 21 bones and joints
  return {
    hand,
    transportTimeSeconds: 1.0,
    layerOrder,
    bones: [
      // Forearm
      { a: [5.0, 1.0, 0.4], b: [5.0, -5.0, 0.8], kind: "forearm" },
      { a: [5.8, 1.0, 0.4], b: [5.8, -5.0, 0.8], kind: "forearm" },
      // Carpals
      { a: [5.0, 1.0, 0.4], b: [5.8, 1.0, 0.4], kind: "carpal" },
      // Index (f=2)
      { a: [5.3, 1.8, 0.4], b: [5.3, 2.4, 0.4], kind: "metacarpal" },
      { a: [5.3, 2.4, 0.4], b: [5.3, 3.1, 0.3], kind: "proximal" },
      { a: [5.3, 3.1, 0.3], b: [5.3, 3.7, 0.2], kind: "middle" },
      { a: [5.3, 3.7, 0.2], b: [5.3, 4.2, 0.1], kind: "distal" },
      // Middle (f=3)
      { a: [5.5, 1.8, 0.4], b: [5.5, 2.5, 0.4], kind: "metacarpal" },
      { a: [5.5, 2.5, 0.4], b: [5.5, 3.3, 0.3], kind: "proximal" },
      { a: [5.5, 3.3, 0.3], b: [5.5, 3.9, 0.2], kind: "middle" },
      { a: [5.5, 3.9, 0.2], b: [5.5, 4.5, 0.1], kind: "distal" },
      // Ring (f=4)
      { a: [5.7, 1.8, 0.4], b: [5.7, 2.4, 0.4], kind: "metacarpal" },
      { a: [5.7, 2.4, 0.4], b: [5.7, 3.1, 0.3], kind: "proximal" },
      { a: [5.7, 3.1, 0.3], b: [5.7, 3.7, 0.2], kind: "middle" },
      { a: [5.7, 3.7, 0.2], b: [5.7, 4.2, 0.1], kind: "distal" },
      // Little (f=5)
      { a: [5.9, 1.7, 0.4], b: [5.9, 2.3, 0.4], kind: "metacarpal" },
      { a: [5.9, 2.3, 0.4], b: [5.9, 2.9, 0.3], kind: "proximal" },
      { a: [5.9, 2.9, 0.3], b: [5.9, 3.4, 0.2], kind: "middle" },
      { a: [5.9, 3.4, 0.2], b: [5.9, 3.8, 0.1], kind: "distal" },
      // Thumb (f=1), last in the canonical DTO order [2, 3, 4, 5, 1]
      { a: [5.2, 1.5, 0.4], b: [5.0, 2.0, 0.3], kind: "metacarpal" },
      { a: [5.0, 2.0, 0.3], b: [4.8, 2.5, 0.2], kind: "proximal" },
      { a: [4.8, 2.5, 0.2], b: [4.6, 3.0, 0.1], kind: "distal" },
    ],
    joints: [
      { point: [5.0, 1.0, 0.4], kind: "wrist" },
      { point: [5.8, 1.0, 0.4], kind: "wrist" },
      { point: [5.3, 4.2, 0.1], kind: "tip" },
      { point: [5.5, 4.5, 0.1], kind: "tip" },
      { point: [5.7, 4.2, 0.1], kind: "tip" },
      { point: [5.9, 3.8, 0.1], kind: "tip" },
      { point: [4.6, 3.0, 0.1], kind: "tip" },
      { point: [5.3, 2.4, 0.4], kind: "knuckle" },
      { point: [5.5, 2.5, 0.4], kind: "knuckle" },
      { point: [5.7, 2.4, 0.4], kind: "knuckle" },
      { point: [5.9, 2.3, 0.4], kind: "knuckle" },
    ],
  };
}

describe("normalizeSkinSettings", () => {
  it("returns default settings for undefined, null, or empty object", () => {
    const fromUndef = normalizeSkinSettings();
    expect(fromUndef.style).toBe("cartoon");
    expect(fromUndef.finger_width).toBe(0.75);
    expect(fromUndef.outline).toBe(1.0);
    expect(fromUndef.details).toBe(true);
    expect(fromUndef.sleeve).toBe(true);
    expect(fromUndef.shadow).toBe(true);

    const fromNull = normalizeSkinSettings(null);
    expect(fromNull).toEqual(DEFAULT_SKIN_SETTINGS);

    const fromEmpty = normalizeSkinSettings({});
    expect(fromEmpty).toEqual(DEFAULT_SKIN_SETTINGS);
  });

  it("preserves valid styles and falls back for invalid style strings", () => {
    const validStyles: SkinStyle[] = [
      "skeleton",
      "cartoon",
      "gloves",
      "robot",
      "realistic",
      "photo-segmented",
      "photo-mesh",
      "photo-3d",
    ];
    for (const style of validStyles) {
      expect(normalizeSkinSettings({ style }).style).toBe(style);
    }

    // Invalid style falls back to default cartoon
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeSkinSettings({ style: "cyberpunk" as any }).style).toBe("cartoon");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeSkinSettings({ style: "" as any }).style).toBe("cartoon");
  });

  it("clamps finger_width within [0.5, 1.2]", () => {
    expect(normalizeSkinSettings({ finger_width: -1.0 }).finger_width).toBe(FINGER_WIDTH_RANGE[0]);
    expect(normalizeSkinSettings({ finger_width: 0.2 }).finger_width).toBe(0.5);
    expect(normalizeSkinSettings({ finger_width: 0.85 }).finger_width).toBe(0.85);
    expect(normalizeSkinSettings({ finger_width: 1.5 }).finger_width).toBe(FINGER_WIDTH_RANGE[1]);
    expect(normalizeSkinSettings({ finger_width: 99.0 }).finger_width).toBe(1.2);
  });

  it("clamps outline within [0.0, 2.5]", () => {
    expect(normalizeSkinSettings({ outline: -0.5 }).outline).toBe(OUTLINE_RANGE[0]);
    expect(normalizeSkinSettings({ outline: 0.0 }).outline).toBe(0.0);
    expect(normalizeSkinSettings({ outline: 1.75 }).outline).toBe(1.75);
    expect(normalizeSkinSettings({ outline: 3.0 }).outline).toBe(OUTLINE_RANGE[1]);
    expect(normalizeSkinSettings({ outline: 100 }).outline).toBe(2.5);
  });

  it("clamps color channels to integers [0, 255] and handles partial colors", () => {
    const normalized = normalizeSkinSettings({
      colors: {
        cartoon: {
          skin: [300, -10, 150.8],
        },
      },
    });

    expect(normalized.colors.cartoon.skin).toEqual([255, 0, 151]);
    // Other slots in cartoon remain default
    expect(normalized.colors.cartoon.line).toEqual(DEFAULT_SKIN_COLORS.cartoon.line);
    // Other styles remain default
    expect(normalized.colors.robot.shell).toEqual(DEFAULT_SKIN_COLORS.robot.shell);
  });

  it("preserves explicit boolean options", () => {
    const normalized = normalizeSkinSettings({
      details: false,
      sleeve: false,
      shadow: false,
    });
    expect(normalized.details).toBe(false);
    expect(normalized.sleeve).toBe(false);
    expect(normalized.shadow).toBe(false);
  });
});

describe("Color slot mapping for all 4 styles", () => {
  it("defines expected color slots and defaults for all 4 styles", () => {
    expect(DEFAULT_SKIN_COLORS.cartoon).toEqual({
      skin: [247, 197, 152],
      line: [205, 128, 78],
      sleeve: [37, 178, 122],
      nail: [252, 223, 199],
    });

    expect(DEFAULT_SKIN_COLORS.gloves).toEqual({
      glove: [250, 250, 250],
      line: [20, 20, 22],
      arm: [20, 20, 22],
    });

    expect(DEFAULT_SKIN_COLORS.robot).toEqual({
      shell: [232, 231, 228],
      joint: [62, 64, 70],
      tip: [58, 58, 62],
    });

    expect(DEFAULT_SKIN_COLORS.skeleton).toEqual({
      bone: [12, 12, 14],
    });
  });

  it("converts RGB array to 24-bit hex color integer", () => {
    expect(rgbToHex([255, 255, 255])).toBe(0xffffff);
    expect(rgbToHex([0, 0, 0])).toBe(0x000000);
    expect(rgbToHex([247, 197, 152])).toBe(0xf7c598);
    expect(rgbToHex([12, 12, 14])).toBe(0x0c0c0e);
    expect(rgbToHex([250, 250, 250])).toBe(0xfafafa);
  });

  it("linearly mixes RGB colors with clamped blend factors", () => {
    expect(mixRgb([0, 0, 0], [100, 100, 100], 0.5)).toEqual([50, 50, 50]);
    expect(mixRgb([10, 20, 30], [10, 20, 30], 0.8)).toEqual([10, 20, 30]);
    // Below 0 clamps to 0
    expect(mixRgb([0, 0, 0], [100, 100, 100], -0.5)).toEqual([0, 0, 0]);
    // Above 1 clamps to 1
    expect(mixRgb([0, 0, 0], [100, 100, 100], 1.5)).toEqual([100, 100, 100]);
  });
});

describe("Shadow projection offset and alpha attenuation formulas", () => {
  it("calculates projection offset proportional to hand height zIn and ppi", () => {
    // dx = 0.15 * zIn * ppi, dy = 0.25 * zIn * ppi
    expect(computeShadowOffset(0, 50)).toEqual({ dx: 0, dy: 0 });
    expect(computeShadowOffset(1.0, 50)).toEqual({ dx: 7.5, dy: 12.5 });
    expect(computeShadowOffset(2.0, 40)).toEqual({ dx: 12, dy: 20 });
    expect(computeShadowOffset(0.5, 100)).toEqual({ dx: 7.5, dy: 12.5 });
  });

  it("calculates shadow alpha attenuating inversely with hand height zIn", () => {
    // When zIn = 0 (hand on keys), shadow is maximum darkness (alpha = 0.35)
    expect(computeShadowAlpha(0)).toBeCloseTo(0.35, 5);

    // Negative zIn (key depressed) stays clamped at max darkness
    expect(computeShadowAlpha(-0.2)).toBeCloseTo(0.35, 5);

    // As hand lifts, alpha decreases monotonically
    const a0 = computeShadowAlpha(0);
    const a1 = computeShadowAlpha(0.5);
    const a2 = computeShadowAlpha(1.0);
    const a3 = computeShadowAlpha(1.5);

    expect(a0).toBeGreaterThan(a1);
    expect(a1).toBeGreaterThan(a2);
    expect(a2).toBeGreaterThan(a3);

    // At zIn >= 1.5 inches, shadow reaches minimum ambient alpha 0.10
    expect(computeShadowAlpha(1.5)).toBeCloseTo(0.10, 5);
    expect(computeShadowAlpha(2.5)).toBeCloseTo(0.10, 5);
  });
});

describe("Depth scaling and finger width formulas", () => {
  it("evaluates depth scaling invariant: max(0.85, min(1.45, 1.0 + 0.25 * zIn))", () => {
    expect(depthScale(0)).toBe(1.0);
    expect(depthScale(1.0)).toBe(1.25);
    expect(depthScale(2.0)).toBe(1.45); // clamped upper bound
    expect(depthScale(5.0)).toBe(1.45); // clamped upper bound
    expect(depthScale(-0.6)).toBe(0.85); // clamped lower bound
    expect(depthScale(-2.0)).toBe(0.85); // clamped lower bound

    // Range invariant
    for (let z = -3; z <= 5; z += 0.25) {
      const d = depthScale(z);
      expect(d).toBeGreaterThanOrEqual(0.85);
      expect(d).toBeLessThanOrEqual(1.45);
    }
  });

  it("verifies finger width table and taper constants", () => {
    expect(FINGER_W_IN[1]).toBe(0.82); // Thumb
    expect(FINGER_W_IN[2]).toBe(0.70); // Index
    expect(FINGER_W_IN[3]).toBe(0.72); // Middle
    expect(FINGER_W_IN[4]).toBe(0.68); // Ring
    expect(FINGER_W_IN[5]).toBe(0.60); // Little

    expect(SEG_TAPER).toEqual([1.0, 0.9, 0.84]);
  });

  it("computes finger radius correctly", () => {
    const fw = 0.75;
    const ppi = 50;
    const zIn = 0; // depthScale(0) = 1.0

    // Thumb: base = 0.82 * 0.75 * 50 / 2 = 15.375
    // Seg 0 (metacarpal): base * 1.22 = 18.7575
    // Seg 1 (proximal): base * 1.0 = 15.375
    // Seg 2 (distal): base * 0.9 = 13.8375
    expect(computeFingerRadius(1, 0, fw, zIn, ppi)).toBeCloseTo(15.375 * 1.22, 4);
    expect(computeFingerRadius(1, 1, fw, zIn, ppi)).toBeCloseTo(15.375 * 1.0, 4);
    expect(computeFingerRadius(1, 2, fw, zIn, ppi)).toBeCloseTo(15.375 * 0.9, 4);

    // Index (f=2): base = 0.70 * 0.75 * 50 / 2 = 13.125
    // Seg 0 (prox): base * 1.0 = 13.125
    // Seg 1 (mid): base * 0.9 = 11.8125
    // Seg 2 (dist): base * 0.84 = 11.025
    expect(computeFingerRadius(2, 0, fw, zIn, ppi)).toBeCloseTo(13.125 * 1.0, 4);
    expect(computeFingerRadius(2, 1, fw, zIn, ppi)).toBeCloseTo(13.125 * 0.9, 4);
    expect(computeFingerRadius(2, 2, fw, zIn, ppi)).toBeCloseTo(13.125 * 0.84, 4);
  });
});

describe("Geometry algorithms: convex hull, Chaikin, inflate", () => {
  it("computes convex hull of point set", () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5], // interior point
    ];
    const hull = convexHull(pts);
    expect(hull.length).toBe(4);
    expect(hull).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
  });

  it("subdivides polygons with Chaikin smoothing", () => {
    const quad: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const smooth = chaikin(quad, 1);
    expect(smooth.length).toBe(8);
  });

  it("inflates polygon away from its centroid", () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const inflated = inflate(square, 2);
    expect(inflated.length).toBe(4);
    // Center is (5, 5). Corners should move outwards
    expect(inflated[0]![0]).toBeLessThan(0);
    expect(inflated[0]![1]).toBeLessThan(0);
    expect(inflated[2]![0]).toBeGreaterThan(10);
    expect(inflated[2]![1]).toBeGreaterThan(10);
  });
});

describe("Skin renderers execution & visual rendering", () => {
  const layout = new KeyboardLayout();
  layout.compute({
    x: 0,
    y: 100,
    width: 800,
    height: 150,
  });

  it("reconstructs HandGeometry from MotionPose", () => {
    const pose = createMockPose("right");
    const geom = buildHandGeometry(pose, layout, DEFAULT_SKIN_SETTINGS);

    expect(geom.hand).toBe("right");
    expect(geom.wristWidth).toBeGreaterThan(0);
    expect(Object.keys(geom.chains).length).toBe(5);
    expect(Object.keys(geom.radius).length).toBe(5);
    expect(geom.palm.length).toBeGreaterThan(0);
    expect(geom.web.length).toBeGreaterThan(0);
  });

  it("maps the frozen production skeleton using its canonical digit order and coordinate frame", () => {
    const pose = loadTrackedRightGoldenPose();
    const goldenLayout = new KeyboardLayout();
    goldenLayout.compute({ x: 0, y: 100, width: 980, height: 180 });
    const geometry = buildHandGeometry(pose, goldenLayout, DEFAULT_SKIN_SETTINGS);
    const tips = getFingerTipsByFinger(pose);
    const expectedFingerOrder = [2, 3, 4, 5, 1];
    const distalBones = pose.bones.filter((bone) => bone.kind === "distal");
    const keyboardLeft = goldenLayout.getKeyRect(21)?.x ?? goldenLayout.rect.x;
    const keyboardBottom = goldenLayout.rect.y + goldenLayout.rect.height;

    expect(pose.bones).toHaveLength(28);
    expect(pose.joints.filter((joint) => joint.kind === "tip")).toHaveLength(5);
    expect([...tips.keys()]).toEqual(expectedFingerOrder);
    expect(Object.keys(geometry.chains).map(Number).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(geometry.chains[1]).toHaveLength(4);
    for (const finger of [2, 3, 4, 5]) expect(geometry.chains[finger]).toHaveLength(5);

    for (const points of Object.values(geometry.chains)) {
      for (const point of points) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
        expect(Math.hypot(point.x - geometry.wristCenter.x, point.y - geometry.wristCenter.y))
          .toBeLessThan(goldenLayout.ppi * 12);
      }
    }

    for (const [index, finger] of expectedFingerOrder.entries()) {
      const endpoint = distalBones[index]!.b;
      const expectedScreenPoint = {
        x: keyboardLeft + endpoint[0] * goldenLayout.ppi,
        y: keyboardBottom - endpoint[1] * goldenLayout.ppi,
      };
      expect(tips.get(finger)).toEqual(endpoint);
      expect(geometry.chains[finger]!.at(-1)!.x).toBeCloseTo(expectedScreenPoint.x, 5);
      expect(geometry.chains[finger]!.at(-1)!.y).toBeCloseTo(expectedScreenPoint.y, 5);
    }

    const forearms = pose.bones.filter((bone) => bone.kind === "forearm");
    const expectedArmEndY = keyboardBottom -
      forearms.reduce((sum, bone) => sum + bone.b[1], 0) / forearms.length * goldenLayout.ppi;
    expect(geometry.armEnd.y).toBeCloseTo(expectedArmEndY, 5);
  });

  it("keeps canonical finger identities when the thumb crosses to the far right", () => {
    const pose = loadTrackedRightGoldenPose();
    const crossedPose: MotionPose = {
      ...pose,
      bones: pose.bones.map((bone, index) => index >= 25
        ? { ...bone, a: [bone.a[0] + 4, bone.a[1], bone.a[2]], b: [bone.b[0] + 4, bone.b[1], bone.b[2]] }
        : bone),
      joints: (() => {
        let tipOrdinal = 0;
        return pose.joints.map((joint) => {
          if (joint.kind !== "tip") return joint;
          const isThumb = tipOrdinal++ === 4;
          return isThumb
            ? { ...joint, point: [joint.point[0] + 4, joint.point[1], joint.point[2]] }
            : joint;
        });
      })(),
    };
    const tips = getFingerTipsByFinger(crossedPose);
    const tipXs = [...tips.values()].map((point) => point[0]);

    expect([...tips.keys()]).toEqual([2, 3, 4, 5, 1]);
    expect(tips.get(1)![0]).toBeGreaterThan(Math.max(...[2, 3, 4, 5].map((finger) => tips.get(finger)![0])));
    expect(tipXs).toHaveLength(5);
  });

  it("uses bounded inch-space fallbacks for an incomplete chain without shifting finger IDs", () => {
    const pose = loadTrackedRightGoldenPose();
    const missingProximal: MotionPose = {
      ...pose,
      bones: pose.bones.filter((_bone, index) => index !== 10),
    };
    const goldenLayout = new KeyboardLayout();
    goldenLayout.compute({ x: 0, y: 100, width: 980, height: 180 });
    const geometry = buildHandGeometry(missingProximal, goldenLayout, DEFAULT_SKIN_SETTINGS);

    expect([...getFingerTipsByFinger(missingProximal).keys()]).toEqual([2, 3, 4, 5, 1]);
    expect(Object.keys(geometry.chains).map(Number).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const points of Object.values(geometry.chains)) {
      for (const point of points) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThan(-300);
        expect(point.x).toBeLessThan(1300);
        expect(point.y).toBeGreaterThan(-300);
        expect(point.y).toBeLessThan(900);
      }
    }

    const missingDistal: MotionPose = {
      ...pose,
      bones: pose.bones.filter((_bone, index) => index !== 12),
    };
    expect(getFingerTipsByFinger(missingDistal).size).toBe(0);
    expect(Object.keys(buildHandGeometry(missingDistal, goldenLayout, DEFAULT_SKIN_SETTINGS).chains)).toHaveLength(0);
  });

  it("renders all 8 skin styles without errors", () => {
    const pose = createMockPose("right");
    const renderer = new SingleHandRenderer();

    const styles: SkinStyle[] = [
      "skeleton",
      "cartoon",
      "gloves",
      "robot",
      "realistic",
      "photo-segmented",
      "photo-mesh",
      "photo-3d",
    ];
    for (const style of styles) {
      const settings = normalizeSkinSettings({ style });
      expect(() => {
        renderer.render(pose, layout, settings);
      }).not.toThrow();
    }

    renderer.destroy();
  });

  it("renders photo-segmented skin with sprites container", () => {
    const pose = createMockPose("right");
    const renderer = new SingleHandRenderer();

    const settings = normalizeSkinSettings({ style: "photo-segmented" });
    renderer.render(pose, layout, settings);
    expect(renderer.container.children.length).toBeGreaterThanOrEqual(4);

    renderer.destroy();
  });

  it("renders photo-mesh skin with 2.5D deformable mesh container", () => {
    const pose = createMockPose("right");
    const renderer = new SingleHandRenderer();

    const settings = normalizeSkinSettings({ style: "photo-mesh" });
    renderer.render(pose, layout, settings);
    expect(renderer.container.children.length).toBeGreaterThanOrEqual(4);

    renderer.destroy();
  });

  it("renders photo-3d skin with 3D PBR volumetric instructions", () => {
    const pose = createMockPose("left");
    const renderer = new SingleHandRenderer();

    const settings = normalizeSkinSettings({ style: "photo-3d" });
    renderer.render(pose, layout, settings);
    expect(renderer.handGraphics.context.instructions.length).toBeGreaterThan(0);

    renderer.destroy();
  });

  it("renders realistic hand skin with detailed anatomy, tendons, creases, and sleeves", () => {
    const pose = createMockPose("right");
    const renderer = new SingleHandRenderer();

    // Realistic with sleeve and details
    const settingsFull = normalizeSkinSettings({
      style: "realistic",
      details: true,
      sleeve: true,
      shadow: true,
    });
    renderer.render(pose, layout, settingsFull);
    expect(renderer.handGraphics.context.instructions.length).toBeGreaterThan(0);

    // Realistic bare arm and without details
    const settingsMinimal = normalizeSkinSettings({
      style: "realistic",
      details: false,
      sleeve: false,
      shadow: false,
    });
    renderer.render(pose, layout, settingsMinimal);
    expect(renderer.handGraphics.context.instructions.length).toBeGreaterThan(0);

    renderer.destroy();
  });

  it("renders soft drop shadow when shadow=true and clears when shadow=false", () => {
    const pose = createMockPose("left");
    const renderer = new SingleHandRenderer();

    // With shadow enabled
    const shadowOn = normalizeSkinSettings({ shadow: true });
    renderer.render(pose, layout, shadowOn);
    // shadow graphics has drawing operations
    expect(renderer.shadowGraphics.context.instructions.length).toBeGreaterThan(0);

    // With shadow disabled
    const shadowOff = normalizeSkinSettings({ shadow: false });
    renderer.render(pose, layout, shadowOff);
    expect(renderer.shadowGraphics.context.instructions.length).toBe(0);

    renderer.destroy();
  });

  it("HandsView correctly manages skin settings and layer ordering during crossings", () => {
    const view = new HandsView({ keyboardLayout: layout });
    expect(view.getSkinSettings().style).toBe("cartoon");

    // Update skin settings
    view.setSkinSettings(normalizeSkinSettings({ style: "robot", outline: 2.0 }));
    expect(view.getSkinSettings().style).toBe("robot");
    expect(view.getSkinSettings().outline).toBe(2.0);

    // Crossing episode: right hand on top (layerOrder 2 vs 1)
    const leftPose = createMockPose("left", 1);
    const rightPose = createMockPose("right", 2);

    view.setMotionPlan(createMockPlan([leftPose, rightPose]));

    view.update(1.0);

    // Higher layerOrder gets zIndex = 2
    expect(view.rightRenderer.container.zIndex).toBe(2);
    expect(view.leftRenderer.container.zIndex).toBe(1);

    // Reverse crossing episode: left hand on top
    const leftPoseTop = createMockPose("left", 3);
    const rightPoseBottom = createMockPose("right", 1);
    view.setMotionPlan(createMockPlan([leftPoseTop, rightPoseBottom]));

    view.update(1.0);
    expect(view.leftRenderer.container.zIndex).toBe(2);
    expect(view.rightRenderer.container.zIndex).toBe(1);

    view.destroy();
  });
});
