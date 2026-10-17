import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionBuffer } from "../render/motionBuffer";
import type { FrozenVideoExportSnapshot } from "./videoExportSnapshot";
import { createVideoFrameScene } from "./videoExportScene";

const mocks = vi.hoisted(() => ({
  init3d: vi.fn(), create2d: vi.fn(), update: vi.fn(), destroy: vi.fn(),
  camera: vi.fn(), render: vi.fn(), settings: vi.fn(),
}));
vi.mock("../render3d", () => ({ PianoScene3D: class {
  constructor(...args: unknown[]) { mocks.init3d(...args); }
  setNotes = vi.fn(); setMotionPlan = vi.fn(); setMotionBuffer = vi.fn();
  setPerformancePlan = vi.fn(); setDisplaySettings = mocks.settings;
  setPixelsPerSecond = vi.fn(); setCameraPreset = mocks.camera;
  update = mocks.update; destroy = mocks.destroy;
} }));
vi.mock("../render", () => ({ PianoScene: { create: mocks.create2d } }));

describe("isolated video frame scene", () => {
  beforeEach(() => vi.clearAllMocks());
  const canvas = { width: 1920, height: 1080 } as HTMLCanvasElement;
  const buffer = {} as MotionBuffer;
  const snapshot = {
    sceneView: { dimension: "3d", cameraPreset: "overhead" },
    document: { notes: [] }, settings: { showHandShadow: true },
    motionPlan: null, performancePlan: { events: [] },
  } as unknown as FrozenVideoExportSnapshot;

  it("uses the frozen 3D camera and fixed output viewport, manually advancing song time", async () => {
    const scene = await createVideoFrameScene(canvas, snapshot, buffer, "realistic");
    expect(mocks.create2d).not.toHaveBeenCalled();
    expect(mocks.init3d).toHaveBeenCalledWith(canvas, {
      canvas, fixedViewport: { width: 1920, height: 1080, resolution: 1 },
    });
    expect(mocks.camera).toHaveBeenCalledWith("overhead");
    scene.renderAt(2.75);
    expect(mocks.update).toHaveBeenLastCalledWith(2.75);
    scene.destroy();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("keeps the 2D renderer for a frozen 2D view and explicitly renders each frame", async () => {
    const stage = {};
    mocks.create2d.mockResolvedValue({ update: mocks.update, destroy: mocks.destroy,
      getApp: () => ({ stage, renderer: { render: mocks.render } }) });
    const scene = await createVideoFrameScene(canvas, {
      ...snapshot, sceneView: { dimension: "2d", cameraPreset: "concert" },
    }, buffer, "equal");
    expect(mocks.init3d).not.toHaveBeenCalled();
    expect(mocks.create2d).toHaveBeenCalledWith(expect.objectContaining({
      target: canvas, fixedViewport: { width: 1920, height: 1080, resolution: 1 }, keyStyle: "equal",
    }));
    scene.renderAt(1.5);
    expect(mocks.update).toHaveBeenLastCalledWith(1.5);
    expect(mocks.render).toHaveBeenCalledWith(stage);
    scene.destroy();
  });

  it("releases the 3D renderer when preparation fails instead of leaking an export context", async () => {
    mocks.camera.mockImplementationOnce(() => { throw new Error("camera failure"); });
    await expect(createVideoFrameScene(canvas, snapshot, buffer, "realistic")).rejects.toThrow("camera failure");
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
