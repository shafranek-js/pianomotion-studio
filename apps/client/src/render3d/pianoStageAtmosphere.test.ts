import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { PianoStageAtmosphere } from "./pianoStageAtmosphere";

describe("PianoStageAtmosphere", () => {
  it("keeps a soft, non-interactive shaft and perimeter inside the named root", () => {
    const scene = new THREE.Scene();
    const atmosphere = new PianoStageAtmosphere(scene, -20, 80);
    const root = scene.getObjectByName("piano-stage-atmosphere");
    const shaft = scene.getObjectByName("piano-stage-light-shaft");
    const perimeter = scene.getObjectByName("piano-stage-perimeter-glow");

    expect(root).toBe(atmosphere.group);
    expect(shaft?.parent).toBe(root);
    expect(perimeter?.parent).toBe(root);

    const shells = shaft?.children as THREE.Mesh[] | undefined;
    expect(shells).toHaveLength(3);
    for (const shell of shells ?? []) {
      const geometry = shell.geometry as THREE.CylinderGeometry;
      const material = shell.material as THREE.ShaderMaterial;
      expect(geometry.parameters.openEnded).toBe(true);
      expect(geometry.parameters.heightSegments).toBe(1);
      expect(geometry.parameters.radialSegments).toBe(64);
      expect(geometry.parameters.radiusTop / geometry.parameters.radiusBottom).toBeLessThan(1.5);
      expect(shell.castShadow).toBe(false);
      expect(shell.receiveShadow).toBe(false);
      expect(material.transparent).toBe(true);
      expect(material.depthTest).toBe(true);
      expect(material.depthWrite).toBe(false);
      expect(material.blending).toBe(THREE.AdditiveBlending);
      const intersections: THREE.Intersection[] = [];
      shell.raycast(new THREE.Raycaster(), intersections);
      expect(intersections).toHaveLength(0);
    }
    const baseOpacity = shells!.map(shell => (shell.material as THREE.ShaderMaterial).uniforms.uOpacity.value as number);
    expect(baseOpacity.every(value => Number.isFinite(value) && value > 0 && value <= 0.15)).toBe(true);
    atmosphere.setAppearance("concert", 0.5);
    shells!.forEach((shell, index) => {
      expect((shell.material as THREE.ShaderMaterial).uniforms.uOpacity.value).toBeCloseTo(baseOpacity[index]! * 0.5);
    });

    const geometries = shells?.map((shell) => shell.geometry) ?? [];
    atmosphere.setQuality("low", 1280);
    expect(atmosphere.visibleShaftShellCount).toBe(2);
    atmosphere.setQuality("auto", 900);
    expect(atmosphere.visibleShaftShellCount).toBe(2);
    atmosphere.setQuality("auto", 901);
    expect(atmosphere.visibleShaftShellCount).toBe(3);
    atmosphere.setQuality("high", 320);
    expect(atmosphere.visibleShaftShellCount).toBe(3);
    expect(shells?.map((shell) => shell.geometry)).toEqual(geometries);

    atmosphere.setAppearance("studio", 1);
    expect(atmosphere.group.visible).toBe(false);
    atmosphere.setAppearance("concert", 1);
    expect(atmosphere.group.visible).toBe(true);

    const geometryDispose = (shells ?? []).map((shell) => vi.spyOn(shell.geometry, "dispose"));
    const materialDispose = (shells ?? []).map((shell) => vi.spyOn(shell.material as THREE.Material, "dispose"));
    atmosphere.dispose();
    atmosphere.dispose();

    expect(scene.getObjectByName("piano-stage-atmosphere")).toBeUndefined();
    geometryDispose.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
    materialDispose.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
  });
});
