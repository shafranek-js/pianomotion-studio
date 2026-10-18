import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { DEFAULT_STAGE_APPEARANCE } from "../settings/stageAppearance";
import { PianoStage3D } from "./pianoStage3d";

function createStage(viewportWidth = 1280) {
  const scene = new THREE.Scene();
  let currentTarget: THREE.WebGLRenderTarget | null = null;
  const depthSetMask = vi.fn();
  const renderer = {
    shadowMap: { autoUpdate: true },
    xr: { enabled: true },
    state: { buffers: { depth: { setMask: depthSetMask } } },
    getRenderTarget: vi.fn(() => currentTarget),
    setRenderTarget: vi.fn((target: THREE.WebGLRenderTarget | null) => { currentTarget = target; }),
    render: vi.fn(() => { throw new Error("simulated reflection render failure"); }),
  } as unknown as THREE.WebGLRenderer;
  return { scene, renderer, depthSetMask, stage: new PianoStage3D(scene, renderer, viewportWidth) };
}

function getReflector(scene: THREE.Scene): Reflector {
  const reflector = scene.children.find((object) => object.name === "piano-concert-stage-reflection");
  if (!reflector) throw new Error("Stage reflector was not created");
  return reflector as Reflector;
}

function getFloor(scene: THREE.Scene): THREE.Mesh {
  const floor = scene.children.find((object) => object.name === "piano-concert-stage-floor");
  if (!floor) throw new Error("Stage floor was not created");
  return floor as THREE.Mesh;
}

afterEach(() => vi.restoreAllMocks());

describe("PianoStage3D", () => {
  it("tracks bounded reflection targets and disables the pass at zero strength", () => {
    const { scene, stage } = createStage(1280);
    const reflector = getReflector(scene);
    const target = reflector.getRenderTarget();
    const setSize = vi.spyOn(target, "setSize");

    expect(stage.getDiagnostics()).toMatchObject({
      appearance: DEFAULT_STAGE_APPEARANCE,
      reflectionResolution: 512,
      reflectionTargetWidth: 512,
      reflectionTargetHeight: 512,
      reflectionPassEnabled: true,
      atmosphereShaftShellCount: 3,
    });

    stage.setAppearance({ ...DEFAULT_STAGE_APPEARANCE, reflection: 0, quality: "high" });
    expect(stage.getDiagnostics()).toMatchObject({
      reflectionResolution: 1024,
      reflectionTargetWidth: 1024,
      reflectionTargetHeight: 1024,
      reflectionPassEnabled: false,
      atmosphereShaftShellCount: 3,
    });
    expect(reflector.visible).toBe(false);
    expect(stage.getDiagnostics().atmosphereEnabled).toBe(true);
    stage.setAppearance({ ...DEFAULT_STAGE_APPEARANCE, preset: "studio" });
    expect(stage.getDiagnostics().atmosphereEnabled).toBe(false);

    stage.setAppearance({ ...DEFAULT_STAGE_APPEARANCE, quality: "low" });
    expect(stage.getDiagnostics()).toMatchObject({
      reflectionResolution: 256,
      reflectionPassEnabled: true,
      atmosphereShaftShellCount: 2,
    });
    stage.setAppearance({ ...DEFAULT_STAGE_APPEARANCE, quality: "auto" });
    expect(stage.getDiagnostics().reflectionResolution).toBe(512);
    expect(stage.getDiagnostics().atmosphereShaftShellCount).toBe(3);

    stage.setViewportWidth(800);
    expect(stage.getDiagnostics().reflectionResolution).toBe(256);
    expect(stage.getDiagnostics().atmosphereShaftShellCount).toBe(2);
    const callsAtSmallWidth = setSize.mock.calls.length;
    stage.setViewportWidth(800);
    expect(setSize).toHaveBeenCalledTimes(callsAtSmallWidth);
    stage.setViewportWidth(1280);
    expect(stage.getDiagnostics().reflectionResolution).toBe(512);
    expect(stage.getDiagnostics().atmosphereShaftShellCount).toBe(3);

    stage.dispose();
  });

  it("restores the main render state and disposes each stage resource once after a failed reflection", () => {
    const { scene, renderer, depthSetMask, stage } = createStage();
    const reflector = getReflector(scene);
    const floor = getFloor(scene);
    const reflectionTarget = reflector.getRenderTarget();
    const reflectionMaterial = reflector.material as THREE.ShaderMaterial;
    const floorMaterial = floor.material as THREE.MeshPhysicalMaterial;
    const floorGeometry = floor.geometry;
    const reflectionTargetDispose = vi.spyOn(reflectionTarget, "dispose");
    const reflectionMaterialDispose = vi.spyOn(reflectionMaterial, "dispose");
    const floorMaterialDispose = vi.spyOn(floorMaterial, "dispose");
    const floorGeometryDispose = vi.spyOn(floorGeometry, "dispose");
    const atmosphere = scene.getObjectByName("piano-stage-atmosphere");
    const shaft = scene.getObjectByName("piano-stage-light-shaft");
    const perimeter = scene.getObjectByName("piano-stage-perimeter-glow");
    if (!atmosphere || !shaft || !perimeter) throw new Error("Stage atmosphere was not created");
    const render = vi.spyOn(renderer, "render").mockImplementation(() => {
      expect(atmosphere.visible).toBe(true);
      expect(shaft.visible).toBe(false);
      expect(perimeter.visible).toBe(false);
      throw new Error("simulated reflection render failure");
    });
    const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.5, 360);
    camera.position.set(0, 25, 20);
    camera.lookAt(0, 0, -16);
    camera.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);

    expect(() => reflector.onBeforeRender(
      renderer,
      scene,
      camera,
      reflector.geometry,
      reflectionMaterial,
      new THREE.Group(),
    )).toThrow("simulated reflection render failure");

    expect(floor.visible).toBe(true);
    expect(atmosphere.visible).toBe(true);
    expect(shaft.visible).toBe(true);
    expect(perimeter.visible).toBe(true);
    expect(reflector.visible).toBe(true);
    expect(render).toHaveBeenCalledOnce();
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
    expect(renderer.xr.enabled).toBe(true);
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    expect(depthSetMask).toHaveBeenLastCalledWith(true);

    stage.dispose();
    stage.dispose();
    expect(reflectionTargetDispose).toHaveBeenCalledOnce();
    expect(reflectionMaterialDispose).toHaveBeenCalledOnce();
    expect(floorMaterialDispose).toHaveBeenCalledOnce();
    expect(floorGeometryDispose).toHaveBeenCalledOnce();
    expect(stage.getDiagnostics().disposed).toBe(true);
  });
});
