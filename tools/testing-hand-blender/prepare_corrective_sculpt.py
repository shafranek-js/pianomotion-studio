"""Build *unsculpted* joint-specific corrective-shape authoring slots in Blender.

Usage (Blender 4.x; input must be an already SKINNED GLB or .blend):
    blender --background --python tools/testing-hand-blender/prepare_corrective_sculpt.py -- \
      --input apps/client/public/models/hands/improved/left_lod0.glb \
      --output-blend scratch/testing-hand-left-correctives.blend \
      --report scratch/testing-hand-left-correctives.json

The path above is illustrative: use the actual GLB path from
apps/client/public/models/hands/improved/manifest.json.

This creates local vertex masks and EMPTY relative shape-key slots for
MCP/PIP/DIP, thumb CMC/MCP/IP and wrist, but DOES NOT sculpt credible skin.
It refuses unrigged meshes (e.g. hand_standard.glb) and never exports a
production GLB or modifies the original source. Preview must be opened and
calibrated by an artist before any corrective is marked finished.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

try:
    import bpy
    from mathutils import Vector
except ImportError as exc:
    raise SystemExit("Run this script from Blender Python (bpy is required).") from exc


FINGER_PREFIXES = {
    "index": "index-finger",
    "middle": "middle-finger",
    "ring": "ring-finger",
    "pinky": "pinky-finger",
}
# Bone heads denote the articulating joint in the 25-bone GLB convention.
JOINTS = [
    ("thumb", "cmc", "thumb-metacarpal"),
    ("thumb", "mcp", "thumb-phalanx-proximal"),
    ("thumb", "ip", "thumb-phalanx-distal"),
    *[(finger, joint, f"{prefix}-{segment}")
      for finger, prefix in FINGER_PREFIXES.items()
      for joint, segment in (
          ("mcp", "phalanx-proximal"),
          ("pip", "phalanx-intermediate"),
          ("dip", "phalanx-distal"),
      )],
    ("wrist", "flex", "wrist"),
]
ANGLES = (30, 60, 90)
SCHEMA = "pianomotion-corrective-sculpt-v1"


def arguments():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", required=True, type=Path, help="Rigged .glb or .blend (not the unrigged scan)")
    p.add_argument("--output-blend", required=True, type=Path)
    p.add_argument("--report", required=True, type=Path)
    p.add_argument("--side", choices=("left", "right"), required=True)
    return p.parse_args(args)


def load_scene(path):
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.suffix.lower() == ".blend":
        bpy.ops.wm.open_mainfile(filepath=str(path.resolve()))
    elif path.suffix.lower() == ".glb":
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=False)
        bpy.ops.import_scene.gltf(filepath=str(path.resolve()))
    else:
        raise ValueError("Expected a rigged .glb or .blend input")


def find_rigged_hand():
    required = {bone for _, _, bone in JOINTS}
    matching = []
    for arm in (ob for ob in bpy.data.objects if ob.type == "ARMATURE"):
        names = {bone.name for bone in arm.data.bones}
        if not required.issubset(names):
            continue
        meshes = [
            obj for obj in bpy.data.objects
            if obj.type == "MESH" and any(
                mod.type == "ARMATURE" and mod.object == arm for mod in obj.modifiers
            )
        ]
        if len(meshes) == 1:
            matching.append((arm, meshes[0]))
    if len(matching) != 1:
        raise ValueError(
            f"Expected one skinned 25-bone hand, found {len(matching)}. "
            "A raw unrigged scan cannot be used to generate corrective shapes."
        )
    return matching[0]


def prepare_mask(mesh, arm, bone_name, side):
    """Create a local sculpt mask around the anatomical joint head.

    Mask is deliberately soft. It is for artist preview only, not an
    exported morph influence: glTF export must bake the final deltas.
    """
    group_name = f"PM_MASK_{bone_name}"
    group = mesh.vertex_groups.get(group_name)
    if group is None:
        group = mesh.vertex_groups.new(name=group_name)

    bone = arm.data.bones[bone_name]
    # Bone heads are stored in armature-local coordinates.
    joint_world = arm.matrix_world @ bone.head_local
    joint_local = mesh.matrix_world.inverted_safe() @ joint_world
    scale = max((mesh.matrix_world.to_scale()).length / math.sqrt(3), 1e-6)
    radius = max(0.008, min(0.032, bone.length * 0.7)) / scale
    # Cap to a region near this joint. Scans can contain multiple mesh shells,
    # so Euclidean proximity alone is not used for final deformation.
    bone_group = mesh.vertex_groups.get(bone_name)
    related = {
        bone_group.index if bone_group else -1,
    }
    parent = bone.parent
    if parent is not None:
        parent_group = mesh.vertex_groups.get(parent.name)
        if parent_group:
            related.add(parent_group.index)
    affected = 0
    for v in mesh.data.vertices:
        d = (v.co - joint_local).length / radius
        if d >= 2.0:
            continue
        native_strength = sum(
            membership.weight
            for membership in v.groups if membership.group in related
        )
        # The wrist root may have diffuse weights, but shape masks should
        # still localize to the actual wrist instead of the entire forearm.
        if native_strength <= 1e-5:
            continue
        falloff = math.exp(-2.0 * d * d)
        strength = max(0.0, min(1.0, native_strength * falloff))
        if strength <= 0.001:
            continue
        group.add([v.index], strength, "REPLACE")
        affected += 1
    if affected < 10:
        raise ValueError(
            f"Corrective mask {group_name} for {side} covers only {affected} "
            "vertices; check bone heads, transforms and joint axes."
        )
    return group_name, affected


def corrective_deltas(mesh, key):
    basis = mesh.data.shape_keys.key_blocks[0]
    moved = 0
    largest = 0.0
    for rest, sculpted in zip(basis.data, key.data):
        displacement = (sculpted.co - rest.co).length
        if not math.isfinite(displacement):
            raise ValueError(f"Non-finite corrective displacement in {key.name}")
        largest = max(largest, displacement)
        if displacement > 1e-6:
            moved += 1
    return moved, largest


def prepare_shapes(arm, mesh, side):
    if mesh.data.shape_keys is None:
        mesh.shape_key_add(name="Basis", from_mix=False)
    blocks = mesh.data.shape_keys.key_blocks
    mesh.data.shape_keys.use_relative = True
    entries = []

    for finger, joint, bone in JOINTS:
        mask, covered = prepare_mask(mesh, arm, bone, side)
        for angle in ANGLES:
            # Numeric, stable target names are essential for a future Three.js
            # pose driver; Blender drivers are not guaranteed by glTF export.
            name = f"pmcorr_{finger}_{joint}_{angle:03d}"
            key = blocks.get(name)
            if key is None:
                key = mesh.shape_key_add(name=name, from_mix=False)
            key.value = 0
            key.slider_min = 0.0
            key.slider_max = 1.0
            key.vertex_group = mask
            moved, maximum = corrective_deltas(mesh, key)
            entries.append({
                "morph": name, "bone": bone, "angleDegrees": angle,
                "mask": mask, "maskedVertices": covered,
                "changedVertices": moved, "maximumDeltaMeters": maximum,
                "status": "READY_FOR_REVIEW" if moved else "UNSCULPTED",
            })
    return entries


def main():
    arg = arguments()
    if arg.input.resolve() == arg.output_blend.resolve():
        raise ValueError("Refusing to overwrite the source asset")
    load_scene(arg.input)
    arm, mesh = find_rigged_hand()
    if mesh.data.users > 1:
        mesh.data = mesh.data.copy()
    entries = prepare_shapes(arm, mesh, arg.side)

    report = {
        "schema": SCHEMA, "hand": arg.side,
        "source": str(arg.input.resolve()),
        "armature": arm.name, "mesh": mesh.name,
        "vertices": len(mesh.data.vertices),
        "polygons": len(mesh.data.polygons),
        "slots": entries,
        "unsculpted": sum(x["status"] == "UNSCULPTED" for x in entries),
        "validatedInBlender": False,
        "exportReady": False,
        "warnings": [
            "All zero-delta slots must be sculpted, or deliberately omitted.",
            "Pose-specific hinge axes and source bind pose have not been calibrated.",
            "Masks are Blender sculpting aids; bake deltas before glTF export.",
            "Do not deploy GLB/morphs until posed QA passes on both hands and all LODs.",
        ],
    }
    arg.output_blend.parent.mkdir(parents=True, exist_ok=True)
    arg.report.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(arg.output_blend.resolve()))
    arg.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        f"Created {len(entries)} pose-corrective authoring slots "
        f"({report['unsculpted']} unsculpted). BLEND: {arg.output_blend}"
    )
    print("STOP: artist must sculpt, validate, bake masked deltas and approve export.")


if __name__ == "__main__":
    main()
