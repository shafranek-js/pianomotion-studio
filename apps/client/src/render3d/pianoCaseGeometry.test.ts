import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  createPianoCaseGeometry,
  PIANO_CASE_BEVEL_SEGMENTS,
  PIANO_CASE_CREASE_ANGLE,
  PIANO_CASE_CURVE_SEGMENTS,
} from "./pianoCaseGeometry";

function cubicPoint(t: number): THREE.Vector2 {
  const p0 = new THREE.Vector2(4, 3);
  const p1 = new THREE.Vector2(3.5, 3.2);
  const p2 = new THREE.Vector2(1, 2.4);
  const p3 = new THREE.Vector2(0.5, 2);
  return new THREE.Vector2()
    .addScaledVector(p0, (1 - t) ** 3)
    .addScaledVector(p1, 3 * (1 - t) ** 2 * t)
    .addScaledVector(p2, 3 * (1 - t) * t ** 2)
    .addScaledVector(p3, t ** 3);
}

function normalsAtPosition(
  geometry: THREE.BufferGeometry,
  target: THREE.Vector3,
  tolerance = 1e-5,
): THREE.Vector3[] {
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const found: THREE.Vector3[] = [];
  for (let i = 0; i < positions.count; i += 1) {
    if (
      Math.abs(positions.getX(i) - target.x) <= tolerance &&
      Math.abs(positions.getY(i) - target.y) <= tolerance &&
      Math.abs(positions.getZ(i) - target.z) <= tolerance
    ) {
      found.push(new THREE.Vector3().fromBufferAttribute(normals, i));
    }
  }
  return found;
}

describe("piano case extrusion normals", () => {
  it("densely samples curved casing and smooths it while preserving a right-angle seam", () => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(4, 0);
    shape.lineTo(4, 3);
    shape.bezierCurveTo(3.5, 3.2, 1, 2.4, 0.5, 2);
    shape.lineTo(0, 0);
    shape.closePath();

    const geometry = createPianoCaseGeometry(shape, {
      depth: 1,
      bevelEnabled: false,
    });
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    const defaultGeometry = new THREE.ExtrudeGeometry(shape, {
      depth: 1,
      bevelEnabled: false,
    });

    expect(PIANO_CASE_CURVE_SEGMENTS).toBe(64);
    expect(PIANO_CASE_BEVEL_SEGMENTS).toBe(8);
    expect(PIANO_CASE_CREASE_ANGLE).toBeCloseTo(Math.PI / 6, 8);
    expect(geometry.index).toBeNull();
    expect(positions.count).toBeGreaterThan(
      defaultGeometry.getAttribute("position").count * 3,
    );
    for (let i = 0; i < normals.count; i += 1) {
      const normal = new THREE.Vector3().fromBufferAttribute(normals, i);
      expect(Number.isFinite(normal.x + normal.y + normal.z)).toBe(true);
      expect(normal.length()).toBeCloseTo(1, 5);
    }

    // At the center of the sampled Bezier, adjacent side faces share one
    // continuous normal while the perpendicular extrusion cap remains separate.
    const midpoint = cubicPoint(0.5);
    const curvedSideNormals = normalsAtPosition(
      geometry,
      new THREE.Vector3(midpoint.x, midpoint.y, 0),
    ).filter((normal) => Math.abs(normal.z) < 0.1);
    expect(curvedSideNormals.length).toBeGreaterThanOrEqual(2);
    for (const normal of curvedSideNormals) {
      expect(normal.dot(curvedSideNormals[0]!)).toBeGreaterThan(0.999);
    }

    const cornerNormals = normalsAtPosition(geometry, new THREE.Vector3(4, 0, 0)).filter(
      (normal) => Math.abs(normal.z) < 0.1,
    );
    expect(cornerNormals.length).toBeGreaterThanOrEqual(2);
    expect(
      cornerNormals.some((a, index) =>
        cornerNormals.slice(index + 1).some((b) => Math.abs(a.dot(b)) < 0.1),
      ),
    ).toBe(true);

    defaultGeometry.dispose();
    geometry.dispose();
  });
});
