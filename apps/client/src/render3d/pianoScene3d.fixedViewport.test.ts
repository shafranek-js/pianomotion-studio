import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Actual-asset scene test reads checked-in GLBs with Node fs.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import type { MotionPlan, MotionPose, Note, PerformancePlan } from "@handthesia/contracts";
import { FallingNotes3DView } from "./fallingNotes3dView";
import * as handRigBuilder from "./handRigBuilder";
import { Hand3DMeshGroup } from "./handRigBuilder";
import { Keyboard3DView } from "./keyboard3dView";
import { IMPROVED_HAND_MODEL_ID, type HandModelId } from "./improvedHandRuntime";
import { PianoScene3D, type Camera3DPreset, type RiggedPoseEditPair } from "./pianoScene3d";
import { RiggedExperimentalHand } from "./riggedExperimentalHand";
import { HABANERA_49_RIGHT_SOURCE_POSE } from "./testingHandHabanera49Fixture";

const mocks = vi.hoisted(() => {
  const canvas = {
    width: 0,
    height: 0,
    className: "",
    tabIndex: -1,
    style: {} as Record<string, string>,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setAttribute: vi.fn(),
    remove: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ left: 0, top: 0, width: 1920, height: 1080 })),
  };
  return {
    canvas,
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
    rendererDispose: vi.fn(),
    resizeObserver: vi.fn(),
    setSizeCalls: 0,
    throwOnSetSizeCall: 0,
  };
});

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class TestWebGLRenderer {
    public readonly domElement = mocks.canvas as unknown as HTMLCanvasElement;
    public readonly shadowMap: Record<string, unknown> = {};
    public readonly info = {
      render: { calls: 0, triangles: 0 },
      memory: { geometries: 0, textures: 0 },
    };

    public setPixelRatio(ratio: number): void {
      mocks.setPixelRatio(ratio);
    }

    public setSize(width: number, height: number): void {
      mocks.setSize(width, height);
      mocks.setSizeCalls += 1;
      if (mocks.setSizeCalls === mocks.throwOnSetSizeCall) throw new Error("test setSize failure");
      mocks.canvas.width = width;
      mocks.canvas.height = height;
    }

    public render(...args: unknown[]): void {
      mocks.render(...args);
    }

    public dispose(): void {
      mocks.rendererDispose();
    }
  }

  class TestPMREMGenerator {
    public fromScene(): { texture: THREE.Texture } {
      return { texture: new actual.Texture() };
    }
    public dispose(): void {}
  }

  return { ...actual, WebGLRenderer: TestWebGLRenderer, PMREMGenerator: TestPMREMGenerator };
});

const viewports = {
  width: 1920,
  height: 1080,
  resolution: 1 as const,
};

function makeScene(initialHandModel: HandModelId = "anatomical"): PianoScene3D {
  const target = { clientWidth: 480, clientHeight: 270 } as HTMLElement;
  return new PianoScene3D(target, {
    canvas: mocks.canvas as unknown as HTMLCanvasElement,
    fixedViewport: viewports,
    initialHandModel,
  });
}

function sourceNote(overrides: Partial<Note> = {}): Note {
  return {
    noteId: "n1",
    trackId: "t0",
    pitch: 60,
    startSeconds: 1,
    endSeconds: 10,
    velocity: 90,
    hand: "left",
    finger: 1,
    glissando: false,
    ...overrides,
  };
}

function emptyPerformancePlan(): PerformancePlan {
  return {
    schemaVersion: 1,
    kind: "performance",
    planId: "pp1",
    projectId: "project1",
    inputRevision: 0,
    profileId: "profile1",
    profileRevision: 0,
    engineVersion: "engine1",
    diagnostics: [],
    fingeringPlanId: "fp1",
    events: [],
  };
}

function motionPlan(): MotionPlan {
  return {
    schemaVersion: 1,
    kind: "motion",
    planId: "mp1",
    projectId: "project1",
    inputRevision: 0,
    profileId: "profile1",
    profileRevision: 0,
    engineVersion: "engine1",
    diagnostics: [],
    performancePlanId: "pp1",
    coordinateFrame: "keyboard-local-inches-v1",
    poses: [{
      hand: "left",
      transportTimeSeconds: 0,
      layerOrder: 0,
      bones: [{ a: [0, 0, 0], b: [1, 0, 0], kind: "forearm" }],
      joints: [{ point: [0, 0, 0], kind: "wrist" }],
    }],
  };
}

function isKeyPressed(scene: PianoScene3D, pitch: number): boolean {
  const keyboard = (scene as unknown as { keyboard3D: Keyboard3DView }).keyboard3D;
  return keyboard.keysByPitch.get(pitch)!.pivotGroup.rotation.x !== 0;
}

function actualHandBuffer(side: "left" | "right"): ArrayBuffer {
  const bytes = readFileSync(new URL(`../../public/models/hands/rigged-experimental/${side}.glb`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function mirroredHabaneraPose(): MotionPose {
  const pose = structuredClone(HABANERA_49_RIGHT_SOURCE_POSE);
  const mirror = (point: [number, number, number]): [number, number, number] => [
    handRigBuilder.KEYBOARD_WIDTH_IN - point[0], point[1], point[2],
  ];
  return {
    ...pose,
    hand: "left",
    joints: pose.joints.map(joint => ({ ...joint, point: mirror(joint.point) })),
    bones: pose.bones.map(bone => ({ ...bone, a: mirror(bone.a), b: mirror(bone.b) })),
  };
}

function leftHandUpdate(scene: PianoScene3D): ReturnType<typeof vi.spyOn> {
  const leftHand = (scene as unknown as { leftHand3D: Hand3DMeshGroup }).leftHand3D;
  return vi.spyOn(leftHand, "updateFromPose").mockImplementation(() => {});
}

describe("PianoScene3D fixed viewport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canvas.width = 0;
    mocks.canvas.height = 0;
    mocks.canvas.style = {};
    mocks.setSizeCalls = 0;
    mocks.throwOnSetSizeCall = 0;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("boots improved and WebXR without anatomical asset requests or anatomical fallback textures", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return { ok: false, status: 404 } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const nativeFs = {
      existsSync: () => false,
      readFileSync: () => { throw new Error("No local anatomical fixture should be read."); },
    };
    const anatomicalPreloadSpy = vi.spyOn(handRigBuilder, "preloadAnatomicalHandModels");
    const runtimeProcess = Reflect.get(globalThis, "process") as { getBuiltinModule: (name: string) => unknown };
    const getBuiltinModule = runtimeProcess.getBuiltinModule.bind(runtimeProcess);
    const builtinModuleSpy = vi.spyOn(runtimeProcess, "getBuiltinModule").mockImplementation((name: string) =>
      name === "fs" ? nativeFs as never : getBuiltinModule(name),
    );

    const improvedScene = makeScene(IMPROVED_HAND_MODEL_ID);
    let webxrScene: PianoScene3D | null = null;
    try {
      await expect(improvedScene.waitForHandModelReady()).rejects.toThrow("Improved hand manifest request failed (404)");

      const diagnostics = improvedScene.getHandModelDiagnostics();
      expect(diagnostics.left.requestedModel).toBe(IMPROVED_HAND_MODEL_ID);
      expect(diagnostics.left.loadedModel).toBe("webxr");
      expect(diagnostics.right.loadedModel).toBe("webxr");
      const handGroups = improvedScene as unknown as {
        leftHand3D: Hand3DMeshGroup;
        rightHand3D: Hand3DMeshGroup;
      };
      const leftSkin = (handGroups.leftHand3D as unknown as { skinMaterial: THREE.MeshPhysicalMaterial }).skinMaterial;
      const rightSkin = (handGroups.rightHand3D as unknown as { skinMaterial: THREE.MeshPhysicalMaterial }).skinMaterial;
      expect(leftSkin.map).toBeNull();
      expect(leftSkin.normalMap).toBe(handRigBuilder.getSkinNormalMap());
      expect(leftSkin.roughnessMap).toBe(handRigBuilder.getSkinRoughnessMap());
      expect(rightSkin.map).toBeNull();
      expect(rightSkin.normalMap).toBe(handRigBuilder.getSkinNormalMap());
      expect(rightSkin.roughnessMap).toBe(handRigBuilder.getSkinRoughnessMap());
      expect(anatomicalPreloadSpy).not.toHaveBeenCalled();
      expect(requestedUrls.some((url) => /anatomical_(left|right)\.glb/.test(url))).toBe(false);
      expect(requestedUrls.some((url) => /anatomical_(base_color\.jpg|normal\.png)/.test(url))).toBe(false);

      const callsAfterImprovedFailure = fetchMock.mock.calls.length;
      webxrScene = makeScene("webxr");
      expect(fetchMock).toHaveBeenCalledTimes(callsAfterImprovedFailure);
      expect(webxrScene.getHandModelDiagnostics().left.loadedModel).toBe("webxr");
      expect(anatomicalPreloadSpy).not.toHaveBeenCalled();
    } finally {
      anatomicalPreloadSpy.mockRestore();
      improvedScene.destroy();
      webxrScene?.destroy();
      builtinModuleSpy.mockRestore();
    }
  });

  it("installs the optional starting pose and refreshes a paused scene after the asset arrives", async () => {
    const presetJson = readFileSync(new URL("../../public/models/hands/rigged-experimental/right_hand_starting_pose.rigged-hand-pose.json", import.meta.url), "utf8");
    let resolvePoseFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => {
      resolvePoseFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const loadSpy = vi.spyOn(RiggedExperimentalHand, "load").mockImplementation(async side =>
      RiggedExperimentalHand.fromBuffer(side, actualHandBuffer(side)),
    );
    const scene = new PianoScene3D(
      { clientWidth: 480, clientHeight: 270 } as HTMLElement,
      {
        canvas: mocks.canvas as unknown as HTMLCanvasElement,
        fixedViewport: viewports,
        initialHandModel: "rigged-experimental",
        leadInDurationSeconds: 2,
      },
    );
    const sceneUpdate = vi.spyOn(scene, "update");
    try {
      const plan = motionPlan();
      scene.setMotionPlan({
        ...plan,
        poses: [mirroredHabaneraPose(), structuredClone(HABANERA_49_RIGHT_SOURCE_POSE)],
      });
      scene.update(-2);
      await scene.waitForHandModelReady();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

      const updatesBeforePresetLoad = sceneUpdate.mock.calls.length;
      resolvePoseFetch({ ok: true, status: 200, text: async () => presetJson } as Response);
      const hands = scene as unknown as { leftHand3D: Hand3DMeshGroup; rightHand3D: Hand3DMeshGroup };
      await vi.waitFor(() => {
        expect((hands.rightHand3D as unknown as { leadInStartPose: unknown }).leadInStartPose).not.toBeNull();
        expect((hands.leftHand3D as unknown as { leadInStartPose: unknown }).leadInStartPose).not.toBeNull();
      });
      expect(sceneUpdate.mock.calls.length).toBeGreaterThan(updatesBeforePresetLoad);
      expect(scene.getHandModelDiagnostics().left.loadedModel).toBe("rigged-experimental");
      expect(scene.getHandModelDiagnostics().right.loadedModel).toBe("rigged-experimental");
    } finally {
      scene.destroy();
      loadSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("orients each actual preset camera toward its target and keeps export dimensions and inputs fixed", () => {
    class TestResizeObserver {
      public constructor() {
        mocks.resizeObserver();
      }
      public observe(): void {}
      public disconnect(): void {}
      public unobserve(): void {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    const scene = makeScene();
    const camera = (scene as unknown as { camera: THREE.PerspectiveCamera }).camera;
    const presets: Array<{ name: Camera3DPreset; target: [number, number, number] }> = [
      { name: "concert", target: [0, 0.2, -4.2] },
      { name: "overhead", target: [0, 0, -5] },
      { name: "pov", target: [0, -0.5, -5.5] },
      { name: "side_arch", target: [-2, 1, -2.5] },
    ];

    for (const preset of presets) {
      scene.setCameraPreset(preset.name);
      const target = new THREE.Vector3(...preset.target);
      const expectedDirection = target.clone().sub(camera.position).normalize();
      const actualDirection = camera.getWorldDirection(new THREE.Vector3());
      expect(actualDirection.distanceTo(expectedDirection)).toBeLessThan(1e-6);
      const targetNdc = target.project(camera);
      expect(targetNdc.x).toBeCloseTo(0, 5);
      expect(targetNdc.y).toBeCloseTo(0, 5);
    }

    expect(mocks.setPixelRatio).toHaveBeenCalledWith(1);
    expect(mocks.setSize).toHaveBeenCalled();
    expect(mocks.setSize.mock.calls.every(([width, height]) => width === 1920 && height === 1080)).toBe(true);
    expect(mocks.canvas.width).toBe(1920);
    expect(mocks.canvas.height).toBe(1080);
    expect(mocks.resizeObserver).not.toHaveBeenCalled();
    expect(mocks.canvas.addEventListener).not.toHaveBeenCalled();

    scene.destroy();
    scene.destroy();
    expect(mocks.rendererDispose).toHaveBeenCalledOnce();
    expect(mocks.canvas.remove).not.toHaveBeenCalled();
  });

  it("cleans up renderer and partially initialized 3D resources while preserving a borrowed canvas", () => {
    mocks.throwOnSetSizeCall = 2;
    const keyboardDispose = vi.spyOn(Keyboard3DView.prototype, "dispose");
    const fallingDispose = vi.spyOn(FallingNotes3DView.prototype, "dispose");
    const handDispose = vi.spyOn(Hand3DMeshGroup.prototype, "dispose");

    expect(makeScene).toThrow("test setSize failure");
    expect(keyboardDispose).toHaveBeenCalledOnce();
    expect(fallingDispose).toHaveBeenCalledOnce();
    expect(handDispose).toHaveBeenCalledTimes(2);
    expect(mocks.rendererDispose).toHaveBeenCalledOnce();
    expect(mocks.canvas.remove).not.toHaveBeenCalled();
  });

  it("keeps an empty plan authoritative while explicit score pitches and physical pitches stay separate", () => {
    const scene = makeScene();
    scene.setNotes([sourceNote()]);
    scene.setPerformancePlan(emptyPerformancePlan());
    scene.setLivePressedPitches([61]);
    const handUpdate = leftHandUpdate(scene);
    scene.setMotionPlan(motionPlan());

    scene.update(5, []);
    expect(isKeyPressed(scene, 60)).toBe(false);
    expect(isKeyPressed(scene, 61)).toBe(true);
    expect(handUpdate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      1,
      [],
      undefined,
      5,
      2,
    );

    scene.setLivePressedPitches([]);
    scene.update(5);
    expect(isKeyPressed(scene, 60)).toBe(false);
    scene.destroy();
  });

  it("passes contact targets only while the improved model is selected", () => {
    const setHandModel = vi.spyOn(Hand3DMeshGroup.prototype, "setHandModel").mockImplementation(() => {});
    const scene = makeScene(IMPROVED_HAND_MODEL_ID);
    setHandModel.mockRestore();

    try {
      scene.setNotes([sourceNote()]);
      scene.setMotionPlan(motionPlan());
      const handUpdate = leftHandUpdate(scene);
      scene.update(5);
      expect(handUpdate).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ finger: 1, pitch: 60 })]),
        undefined,
        5,
        2,
      );
    } finally {
      scene.destroy();
    }
  });

  it("reports sampled pose editing unavailable for a non-experimental hand model", () => {
    const scene = makeScene("anatomical");
    try {
      scene.setMotionPlan(motionPlan());
      const [timepoint] = scene.getPoseEditTimepoints();
      expect(timepoint).toBeDefined();
      expect(scene.getPoseEditAvailability(timepoint!)).toMatchObject({
        available: false,
        reason: "model-mismatch",
      });
    } finally {
      scene.destroy();
    }
  });

  it("rolls both hands back when applying a two-hand pose fails on the second hand", () => {
    const previous = {
      left: { side: "left" },
      right: { side: "right" },
    } as unknown as RiggedPoseEditPair;
    const next = {
      left: { side: "left", marker: "next" },
      right: { side: "right", marker: "next" },
    } as unknown as RiggedPoseEditPair;
    const leftApply = vi.fn();
    const rightApply = vi.fn((pose: unknown) => {
      if (pose === next.right) throw new Error("invalid right hand pose");
    });
    const fakeScene = {
      poseEditActive: true,
      exportPoseEditPair: () => previous,
      leftHand3D: { applyPose: leftApply, refreshPoseEdit: vi.fn() },
      rightHand3D: { applyPose: rightApply, refreshPoseEdit: vi.fn() },
    } as unknown as PianoScene3D;

    expect(() => PianoScene3D.prototype.applyPoseEditPair.call(fakeScene, next)).toThrow("invalid right hand pose");
    expect(leftApply.mock.calls.map(([pose]) => pose)).toEqual([next.left, previous.left]);
    expect(rightApply.mock.calls.map(([pose]) => pose)).toEqual([next.right, previous.right]);
  });

  it("uses performed intervals for rolled timing, early release, hover, and backward seeks", () => {
    const scene = makeScene();
    scene.setNotes([sourceNote()]);
    const plan = emptyPerformancePlan();
    plan.events = [
      { type: "press", noteId: "n1", pitch: 60, velocity: 90, timeSeconds: 2 },
      { type: "release", noteId: "n1", timeSeconds: 3 },
    ];
    scene.setPerformancePlan(plan);
    const handUpdate = leftHandUpdate(scene);
    scene.setMotionPlan(motionPlan());

    scene.update(2.5);
    expect(isKeyPressed(scene, 60)).toBe(true);
    expect(handUpdate).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 0, [], undefined, 2.5, 2,
    );

    scene.update(3.5);
    expect(isKeyPressed(scene, 60)).toBe(false);
    expect(handUpdate).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 1, [], undefined, 3.5, 2,
    );

    scene.update(2.5);
    expect(isKeyPressed(scene, 60)).toBe(true);
    scene.destroy();
  });
});
