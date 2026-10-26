"""Identify exact source-mesh triangles with severe 60° joint deformation.

This is offline diagnostic evidence on real, unchanged LOD0 Blender meshes.
It compares baseline LBS to the previously baked bounded 60° corrective,
ranking the same joint-local triangles by compression and edge collapse.
Neither the unsigned hinge rotation nor DQS target is anatomically approved.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prototype_joint_correctives import select_rig
from prototype_mcp_corrective import capture_vertices, group_weights

JOINTS = (
    ("ring-mcp", "ring-finger-phalanx-proximal", "pmcorr_ring_mcp_060"),
    ("pinky-dip", "pinky-finger-phalanx-distal", "pmcorr_pinky_dip_060"),
)
BEND_DEGREES = 60


def parse_args():
    cli = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True, type=Path)
    p.add_argument("--axes", required=True, type=Path)
    p.add_argument("--side", required=True, choices=("left", "right"))
    p.add_argument("--output", required=True, type=Path)
    return p.parse_args(cli)


def surface_metrics(rest, posed, triangles):
    a, b, c = (triangles[:, i] for i in range(3))
    rest_cross = np.cross(rest[b] - rest[a], rest[c] - rest[a])
    posed_cross = np.cross(posed[b] - posed[a], posed[c] - posed[a])
    rest_area = np.linalg.norm(rest_cross, axis=1) * .5
    posed_area = np.linalg.norm(posed_cross, axis=1) * .5
    if np.any(rest_area < 1e-12):
        raise ValueError("Degenerate rest triangle prevents meaningful area comparison")
    ratio = posed_area / rest_area
    edge_ratios = []
    for start, end in ((a, b), (b, c), (c, a)):
        base = np.linalg.norm(rest[end] - rest[start], axis=1)
        current = np.linalg.norm(posed[end] - posed[start], axis=1)
        if np.any(base < 1e-9):
            raise ValueError("Degenerate rest edge prevents meaningful edge comparison")
        edge_ratios.append(current / base)
    edges = np.stack(edge_ratios, axis=1)
    if not np.all(np.isfinite(ratio)) or not np.all(np.isfinite(edges)):
        raise ValueError("Non-finite surface distortion in real Blender mesh")
    return ratio, edges


def triangle_record(mesh, tri_index, tri, rest, posed, area_ratio, edge_ratios):
    indices = [int(i) for i in tri]
    influences = {}
    for vertex_id in indices:
        for group in mesh.data.vertices[vertex_id].groups:
            name = mesh.vertex_groups[group.group].name
            if name.startswith("PM_MASK_") or group.weight <= 0:
                continue
            influences[name] = influences.get(name, 0.0) + float(group.weight) / 3
    contributors = sorted(influences.items(), key=lambda row: -row[1])[:5]
    return {
        "polygonIndex": int(tri_index),
        "vertexIndices": indices,
        "restCentroidMeshLocalMeters": [float(n) for n in rest[tri].mean(axis=0)],
        "posedCentroidMeshLocalMeters": [float(n) for n in posed[tri].mean(axis=0)],
        "areaRatio": float(area_ratio),
        "smallestEdgeRatio": float(np.min(edge_ratios)),
        "largestEdgeRatio": float(np.max(edge_ratios)),
        "skinInfluencesMeanAcrossTriangle": [
            {"bone": name, "meanWeight": float(weight)}
            for name, weight in contributors
        ],
    }


def joint_variant_report(mesh, rest, all_triangles, indices, local_triangles,
                         pose, variant):
    ratio, edges = surface_metrics(rest, pose, local_triangles)
    n = len(ratio)
    score = {
        "regionTriangles": n,
        "belowQuarterArea": int(np.count_nonzero(ratio < .25)),
        "belowHalfArea": int(np.count_nonzero(ratio < .5)),
        "aboveDoubleArea": int(np.count_nonzero(ratio > 2)),
        "minimumAreaRatio": float(np.min(ratio)),
        "maximumAreaRatio": float(np.max(ratio)),
        "minimumEdgeRatio": float(np.min(edges)),
        "maximumEdgeRatio": float(np.max(edges)),
    }
    def records(order):
        return [
            triangle_record(mesh, indices[int(i)],
                            local_triangles[int(i)], rest, pose,
                            ratio[int(i)], edges[int(i)])
            for i in order[:12]
        ]
    score.update({
        "variant": variant,
        "mostCompressedFaces": records(np.argsort(ratio)),
        "mostExpandedFaces": records(np.argsort(-ratio)),
        "worstEdgeCollapseFaces": records(np.argsort(np.min(edges, axis=1))),
    })
    if any(not math.isfinite(score[k]) for k in (
            "minimumAreaRatio", "maximumAreaRatio",
            "minimumEdgeRatio", "maximumEdgeRatio")):
        raise ValueError("Nonfinite joint summary")
    return score


def main():
    args = parse_args()
    if not args.input.is_file() or not args.axes.is_file():
        raise FileNotFoundError("Real hand .blend and measured hinge report are required")
    report = json.loads(args.axes.read_text(encoding="utf8"))
    if (report.get("schema") != "testing-unsigned-hinge-axes-v1"
            or report.get("side") != args.side
            or report.get("anatomicalAxesCalibrated") is not False
            or report.get("exportApproved") is not False):
        raise ValueError("Axis report mismatch or misleading approval")
    axis_map = {item["bone"]: item["axisBoneLocalUnsigned"]
                for item in report["joints"]}
    bpy.ops.wm.open_mainfile(filepath=str(args.input.resolve()))
    arm, mesh, modifier = select_rig()
    shapes = mesh.data.shape_keys.key_blocks if mesh.data.shape_keys else None
    if shapes is None:
        raise ValueError("Real corrective test mesh has no shape keys")
    for shape in shapes:
        shape.value = 0
    rest = np.array([v.co[:] for v in mesh.data.vertices], dtype=np.float64)
    all_triangles = np.array([list(p.vertices) for p in mesh.data.polygons], dtype=np.int32)
    if len(all_triangles) < 100 or all_triangles.shape[1] != 3:
        raise ValueError("The real LOD0 mesh must have triangulated topology")
    if not np.all(np.isfinite(rest)):
        raise ValueError("Nonfinite rest vertices")
    records = []
    for label, bone_name, shape_name in JOINTS:
        if bone_name not in axis_map or shapes.get(shape_name) is None:
            raise ValueError("Missing measured bone axis / bounded shape key")
        axis = Vector(axis_map[bone_name])
        if not all(math.isfinite(float(x)) for x in axis) or abs(axis.length - 1) > .001:
            raise ValueError("Invalid measured hinge axis")
        if axis.x < 0:
            axis.negate()
        mask_name = "PM_MASK_" + bone_name
        mask = group_weights(mesh, mask_name) > .04
        local_selection = np.count_nonzero(mask[all_triangles], axis=1) >= 2
        tri_indices = np.flatnonzero(local_selection)
        if len(tri_indices) < 10:
            raise ValueError("Too few affected joint-local triangles")
        tris = all_triangles[tri_indices]
        joint = arm.pose.bones[bone_name]
        original_mode, original_rotation = joint.rotation_mode, joint.rotation_quaternion.copy()
        morph = shapes[shape_name]
        original_morph = morph.value
        try:
            joint.rotation_mode = "QUATERNION"
            joint.rotation_quaternion = Quaternion(axis, math.radians(BEND_DEGREES))
            modifier.use_deform_preserve_volume = False
            morph.value = 0
            linear = capture_vertices(mesh)
            morph.value = 1
            corrected = capture_vertices(mesh)
            variants = [
                joint_variant_report(mesh, rest, all_triangles, tri_indices,
                                     tris, linear, "lbs"),
                joint_variant_report(mesh, rest, all_triangles, tri_indices,
                                     tris, corrected, "bounded-corrective"),
            ]
            records.append({
                "joint": label, "bone": bone_name, "shapeKey": shape_name,
                "jointRegionMaskVertices": int(np.count_nonzero(mask)),
                "jointAxisBoneLocalUnsigned": [float(v) for v in axis],
                "bendDegrees": BEND_DEGREES,
                "variants": variants,
            })
        finally:
            morph.value = original_morph
            joint.rotation_quaternion = original_rotation
            joint.rotation_mode = original_mode
            modifier.use_deform_preserve_volume = False
    result = {
        "schema": "testing-real-lod0-fold-polygons-v1",
        "side": args.side,
        "meshVertices": int(len(rest)),
        "meshTriangles": int(len(all_triangles)),
        "joints": records,
        "axisSignedAndAnatomicallyCalibrated": False,
        "visualAcceptance": False,
        "exportApproved": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf8")
    print("[Testing original triangle hot spots]", args.side, len(records),
          "joints measured, geometry NOT approved")


if __name__ == "__main__":
    main()
