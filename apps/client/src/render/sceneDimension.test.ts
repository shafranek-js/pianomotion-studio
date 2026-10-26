import { beforeEach, describe, expect, it, vi } from "vitest";
import { PianoScene } from "./pianoScene";

const mocks = vi.hoisted(() => ({ init: vi.fn(), destroy: vi.fn(), settings: vi.fn(), visible: vi.fn() }));
vi.mock("../render3d", () => ({ PianoScene3D: class {
  constructor(...args: unknown[]) { mocks.init(...args); }
  setNotes = vi.fn(); setMotionPlan = vi.fn(); setMotionBuffer = vi.fn();
  setPerformancePlan = vi.fn(); setPixelsPerSecond = vi.fn(); setDisplaySettings = mocks.settings;
  setPlayAlongMode = vi.fn(); setPlayAlongTargetPitches = vi.fn(); setLivePressedPitches = vi.fn();
  setCameraPreset = vi.fn(); setKeyInputHandlers = vi.fn(); setVisible = mocks.visible;
  destroy = mocks.destroy;
} }));

function sceneHarness() {
  const canvas = { style: { visibility: "visible" } };
  const scene = Object.assign(Object.create(PianoScene.prototype), {
    fixedViewport: undefined, isDestroyed: false, mode3D: false, scene3D: null,
    target: {}, app: { canvas }, fingeringEditor: { active: false },
    handsView: { getMotionBuffer: () => null }, keyboardView: { getTargetKeys: () => null },
    notes: [], displaySettings: {}, livePhysicalPitches: new Set(), update: vi.fn(),
  }) as unknown as PianoScene;
  return { scene, canvas };
}

describe("transactional 3D activation", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("keeps 2D available after a renderer failure and permits a later successful retry", () => {
    const { scene, canvas } = sceneHarness();
    mocks.init.mockImplementationOnce(() => { throw new Error("WebGL unavailable"); });
    expect(() => scene.set3DMode(true)).toThrow("WebGL unavailable");
    expect(scene.is3DMode()).toBe(false);
    expect(canvas.style.visibility).toBe("visible");
    scene.set3DMode(true);
    expect(scene.is3DMode()).toBe(true);
    expect(canvas.style.visibility).toBe("hidden");
    scene.set3DMode(false);
    expect(canvas.style.visibility).toBe("visible");
    expect(mocks.visible).toHaveBeenLastCalledWith(false);
  });

  it("disposes a candidate whose setup failed without publishing it as the active scene", () => {
    const { scene } = sceneHarness();
    mocks.settings.mockImplementationOnce(() => { throw new Error("setup failed"); });
    expect(() => scene.set3DMode(true)).toThrow("setup failed");
    expect(scene.is3DMode()).toBe(false);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    scene.set3DMode(true);
    expect(mocks.init).toHaveBeenCalledTimes(2);
  });

  it("forwards the selected hand model when the live 3D scene is first created", () => {
    const { scene } = sceneHarness();
    (scene as unknown as { displaySettings: { handModel: string } }).displaySettings.handModel = "anatomical-improved";

    scene.set3DMode(true);

    expect(mocks.init).toHaveBeenCalledWith({}, { initialHandModel: "anatomical-improved" });
  });
});
