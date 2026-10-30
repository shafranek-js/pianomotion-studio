"""Read-only inventory and isolated GLB candidate exporter for Testing2 hand rigs.

Run with Blender's bundled Python, not the app's Python environment. This script
never saves the source .blend. All generated files are confined to scratch/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import array
import sys
from collections import Counter
from math import sqrt
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "scratch" / "testing2-candidate"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def vec3(v):
    return [round(float(x), 9) for x in v]


def object_bounds_world(obj):
    return [vec3(obj.matrix_world @ __import__("mathutils").Vector(corner)) for corner in obj.bound_box]


def constraint_summary(constraint):
    target = getattr(constraint, "target", None)
    subtarget = getattr(constraint, "subtarget", None)
    row = {
        "name": constraint.name,
        "type": constraint.type,
        "target": target.name if target else None,
        "subtarget": subtarget or None,
        "influence": round(float(constraint.influence), 6),
        "mute": bool(constraint.mute),
        "ownerSpace": getattr(constraint, "owner_space", None),
        "targetSpace": getattr(constraint, "target_space", None),
    }
    for attr in ("chain_count", "use_stretch", "mix_mode", "use_x", "use_y", "use_z", "invert_x", "invert_y", "invert_z"):
        if hasattr(constraint, attr):
            row[attr] = getattr(constraint, attr)
    return row


def object_summary(obj):
    row = {
        "name": obj.name,
        "type": obj.type,
        "dataName": obj.data.name if obj.data else None,
        "matrixWorld": [[round(float(v), 9) for v in row] for row in obj.matrix_world],
        "dimensionsWorld": vec3(obj.dimensions),
        "boundsWorld": object_bounds_world(obj),
        "parent": obj.parent.name if obj.parent else None,
        "modifiers": [],
        "materials": [m.name if m else None for m in (getattr(obj.data, "materials", []) or [])],
    }
    for mod in obj.modifiers:
        m = {"name": mod.name, "type": mod.type, "showViewport": bool(mod.show_viewport), "showRender": bool(mod.show_render)}
        if mod.type == "ARMATURE":
            m.update({"object": mod.object.name if mod.object else None, "useVertexGroups": bool(mod.use_vertex_groups), "useBoneEnvelopes": bool(mod.use_bone_envelopes)})
        elif mod.type == "MULTIRES":
            m.update({"levels": int(mod.levels), "sculptLevels": int(mod.sculpt_levels), "renderLevels": int(mod.render_levels), "totalLevels": int(mod.total_levels)})
        elif mod.type == "DECIMATE":
            m.update({"ratio": float(mod.ratio), "decimateType": mod.decimate_type})
        row["modifiers"].append(m)
    if obj.type == "MESH":
        mesh = obj.data
        color_attributes = getattr(mesh, "color_attributes", [])
        row["mesh"] = {
            "vertices": len(mesh.vertices), "edges": len(mesh.edges), "loops": len(mesh.loops), "polygons": len(mesh.polygons),
            "triangles": sum(max(0, len(poly.vertices) - 2) for poly in mesh.polygons),
            "vertexGroups": [g.name for g in obj.vertex_groups],
            "shapeKeys": [key.name for key in (mesh.shape_keys.key_blocks if mesh.shape_keys else [])],
            "colorAttributes": [{"name": a.name, "domain": a.domain, "dataType": a.data_type, "activeColor": bool(getattr(a, "is_active_color", False))} for a in color_attributes],
        }
        row["materialDetails"] = []
        for material in (getattr(mesh, "materials", []) or []):
            if material is None:
                continue
            nodes = list(material.node_tree.nodes) if material.node_tree else []
            row["materialDetails"].append({
                "name": material.name,
                "usesNodes": material.node_tree is not None,
                "nodeTypes": [node.type for node in nodes],
                "imageNodes": [node.image.name if getattr(node, "image", None) else None for node in nodes if node.type == "TEX_IMAGE"],
                "vertexColorNodes": [node.name for node in nodes if node.type in {"VERTEX_COLOR", "ATTRIBUTE"}],
            })
        influence_hist = Counter()
        over_four = []
        for vertex in mesh.vertices:
            assigned = []
            for assignment in vertex.groups:
                if assignment.group < len(obj.vertex_groups):
                    name = obj.vertex_groups[assignment.group].name
                else:
                    name = f"<invalid-group-{assignment.group}>"
                assigned.append({"group": name, "weight": round(float(assignment.weight), 9)})
            influence_hist[str(len(assigned))] += 1
            if len(assigned) > 4:
                over_four.append({"vertexIndex": int(vertex.index), "influences": assigned})
        row["mesh"]["influenceCountHistogram"] = dict(sorted(influence_hist.items(), key=lambda x: int(x[0])))
        row["mesh"]["verticesOverFourInfluences"] = over_four
        row["mesh"]["overFourVertexCount"] = len(over_four)
    return row


def armature_summary(obj):
    bones = []
    for bone in obj.data.bones:
        bones.append({
            "name": bone.name,
            "parent": bone.parent.name if bone.parent else None,
            "headLocal": vec3(bone.head_local),
            "tailLocal": vec3(bone.tail_local),
            "useDeform": bool(bone.use_deform),
            "connected": bool(bone.use_connect),
            "length": round(float(bone.length), 9),
            "poseConstraints": [constraint_summary(c) for c in obj.pose.bones[bone.name].constraints],
        })
    return {"name": obj.name, "dataName": obj.data.name, "matrixWorld": [[round(float(v), 9) for v in row] for row in obj.matrix_world], "boneCount": len(bones), "bones": bones}


def evaluated_counts(obj, level, reference_path=None):
    multires = next((m for m in obj.modifiers if m.type == "MULTIRES"), None)
    armature = next((m.object for m in obj.modifiers if m.type == "ARMATURE" and m.object), None)
    original_pose_position = armature.data.pose_position if armature else None
    if multires is not None:
        multires.levels = level
    try:
        if armature:
            armature.data.pose_position = "REST"
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        try:
            mesh.calc_loop_triangles()
            if mesh.vertices:
                from mathutils import Vector
                points = [obj.matrix_world @ v.co for v in mesh.vertices]
                minimum = [min(p[i] for p in points) for i in range(3)]
                maximum = [max(p[i] for p in points) for i in range(3)]
                bounds = {"min": vec3(minimum), "max": vec3(maximum), "size": vec3([maximum[i] - minimum[i] for i in range(3)]), "diagonalMeters": round((Vector(maximum) - Vector(minimum)).length, 9)}
                if reference_path is not None:
                    # Blender Z-up -> glTF Y-up. Keep the full evaluated REST
                    # surface as an independent runtime comparison oracle.
                    flat = array.array("f", (component for p in points for component in (p.x, p.z, -p.y)))
                    if sys.byteorder != "little":
                        flat.byteswap()
                    reference_path.parent.mkdir(parents=True, exist_ok=True)
                    with reference_path.open("wb") as reference_file:
                        flat.tofile(reference_file)
                    bounds["restReference"] = {"filename": reference_path.name, "bytes": reference_path.stat().st_size, "sha256": sha256_file(reference_path), "coordinates": "Blender world XYZ mapped to glTF Y-up XYZ as [x,z,-y], Float32 little-endian triples"}
            else:
                bounds = None
            return {"level": level, "vertices": len(mesh.vertices), "polygons": len(mesh.polygons), "triangles": len(mesh.loop_triangles), "aabbWorld": bounds}
        finally:
            evaluated.to_mesh_clear()
    finally:
        if armature:
            armature.data.pose_position = original_pose_position
        if multires is not None:
            multires.levels = level
        bpy.context.view_layer.update()


def pose_mesh_displacement(obj):
    armature_modifier = next((m for m in obj.modifiers if m.type == "ARMATURE" and m.object), None)
    if armature_modifier is None:
        return None
    multires = next((m for m in obj.modifiers if m.type == "MULTIRES"), None)
    original_level = multires.levels if multires else None
    if multires:
        multires.levels = 0
    armature = armature_modifier.object
    original_pose_position = armature.data.pose_position
    scene = bpy.context.scene
    original_frame = scene.frame_current
    try:
        scene.frame_set(0)
        armature.data.pose_position = "REST"
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        rest_object = obj.evaluated_get(depsgraph)
        rest_mesh = rest_object.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        rest_world = [obj.matrix_world @ v.co for v in rest_mesh.vertices]
        rest_object.to_mesh_clear()

        armature.data.pose_position = "POSE"
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        pose_object = obj.evaluated_get(depsgraph)
        pose_mesh = pose_object.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        pose_world = [obj.matrix_world @ v.co for v in pose_mesh.vertices]
        pose_object.to_mesh_clear()
        distances = [sqrt(sum((a[i] - b[i]) ** 2 for i in range(3))) for a, b in zip(rest_world, pose_world)]
        ordered = sorted(distances)
        return {
            "verticesCompared": min(len(rest_world), len(pose_world)),
            "meanMeters": round(sum(distances) / len(distances), 9),
            "p95Meters": round(ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))], 9),
            "maxMeters": round(max(distances, default=0.0), 9),
            "verticesOver1mm": sum(d > 0.001 for d in distances),
        }
    finally:
        armature.data.pose_position = original_pose_position
        if multires:
            multires.levels = original_level
        scene.frame_set(original_frame)
        bpy.context.view_layer.update()


def run_analysis(source: Path, out_dir: Path):
    objects = sorted(bpy.context.scene.objects, key=lambda o: (o.type, o.name))
    meshes = [o for o in objects if o.type == "MESH"]
    armatures = [o for o in objects if o.type == "ARMATURE"]
    license_file = source.parent / "92895 - LICENSE.html"
    license_text = license_file.read_text(encoding="utf-8", errors="replace") if license_file.is_file() else ""
    report = {
        "schemaVersion": 1,
        "source": {"path": str(source), "bytes": source.stat().st_size, "sha256": sha256_file(source)},
        "sourceLicenseEvidence": {
            "path": str(license_file) if license_file.is_file() else None,
            "bytes": license_file.stat().st_size if license_file.is_file() else None,
            "sha256": sha256_file(license_file) if license_file.is_file() else None,
            "blendSwapId": "92895" if "92895" in license_text else None,
            "titleEvidence": "Human Hands with armature" if "Human Hands with armature" in license_text else None,
            "licenseEvidence": "Creative Commons Zero 1.0" if "Creative Commons Zero 1.0" in license_text else None,
            "scope": "Local adjacent HTML file only; public page has not been independently rechecked.",
        },
        "blender": bpy.app.version_string,
        "actions": {"count": len(bpy.data.actions), "names": [a.name for a in bpy.data.actions]},
        "scene": {"name": bpy.context.scene.name, "unitSettings": {"system": bpy.context.scene.unit_settings.system, "scaleLength": bpy.context.scene.unit_settings.scale_length}, "objects": len(objects)},
        "objects": [object_summary(o) for o in objects],
        "armatures": [armature_summary(o) for o in armatures],
        "mappingEvidence": {
            "armatureNames": [o.name for o in armatures],
            "meshNames": [o.name for o in meshes],
            "sideMap": None,
            "note": "Side mapping and canonical joint names require explicit evidence; no semantic renaming is performed during inventory.",
        },
        "multiresEvaluatedLevels": {},
        "savedPoseVsRest": {},
        "forearmWeightSummary": {},
        "exporter": {"gltfOperatorAvailable": hasattr(bpy.ops.export_scene, "gltf"), "gltfOperatorRna": sorted(bpy.ops.export_scene.gltf.get_rna_type().properties.keys()) if hasattr(bpy.ops.export_scene, "gltf") else [], "settings": {}},
    }
    for obj in meshes:
        multires = next((m for m in obj.modifiers if m.type == "MULTIRES"), None)
        if multires:
            original_level = multires.levels
            report["multiresEvaluatedLevels"][obj.name] = [evaluated_counts(obj, level) for level in range(multires.total_levels + 1)]
            multires.levels = original_level
        report["savedPoseVsRest"][obj.name] = pose_mesh_displacement(obj)
        forearm = next((g for g in obj.vertex_groups if g.name == "Bone.020"), None)
        if forearm:
            membership = []
            for vertex in obj.data.vertices:
                weight = next((a.weight for a in vertex.groups if a.group == forearm.index), 0.0)
                if weight > 0:
                    membership.append((int(vertex.index), float(weight)))
            report["forearmWeightSummary"][obj.name] = {
                "sourceGroupName": forearm.name,
                "verticesWithNonzeroWeight": len(membership),
                "totalAssignedWeight": round(sum(w for _, w in membership), 9),
                "maxWeight": round(max((w for _, w in membership), default=0.0), 9),
                "exampleVertexIndicesFirst20": [v for v, _ in membership[:20]],
                "note": "This counts original mesh memberships; no forearm mesh cut or boundary cap is applied.",
            }
    if report["exporter"]["gltfOperatorAvailable"]:
        props = bpy.ops.export_scene.gltf.get_rna_type().properties
        for key in ("export_all_influences", "export_influence_nb", "export_def_bones", "export_rest_position_armature", "export_skins", "export_apply", "export_animations", "export_yup", "export_materials"):
            if key in props:
                report["exporter"]["settings"][key] = getattr(props[key], "default", None)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "source-inventory.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"INVENTORY_JSON={out_path}")
    print(f"ARMATURES={len(armatures)} MESHES={len(meshes)}")
    for obj in armatures:
        print(f"ARMATURE {obj.name}: bones={len(obj.data.bones)} constraints={sum(len(p.constraints) for p in obj.pose.bones)}")
    for obj in meshes:
        over = report["objects"][[r["name"] for r in report["objects"]].index(obj.name)]["mesh"]["verticesOverFourInfluences"]
        print(f"MESH {obj.name}: vertices={len(obj.data.vertices)} polys={len(obj.data.polygons)} over4={len(over)}")
    return report


def rename_for_export(armature, mesh, side_row, side):
    mapping = side_row["bones"]
    present = set(armature.data.bones.keys())
    missing = sorted(set(mapping) - present)
    if missing:
        raise ValueError(f"{side}: mapped bones absent from {armature.name}: {missing}")
    renamed_bone_names = {old: f"{side}_{new.replace('.', '_')}" for old, new in mapping.items()}
    renamed_group_names = dict(renamed_bone_names)
    for old in mapping:
        if not armature.data.bones[old].use_deform:
            raise ValueError(f"{side}: refuses to rename non-deform/control bone {old}")
        if mesh.vertex_groups.get(old) is None:
            raise ValueError(f"{side}: expected weighted vertex group {old} is absent")
        if mesh.vertex_groups.get(renamed_group_names[old]) is not None:
            raise ValueError(f"{side}: target vertex group name already exists: {renamed_group_names[old]}")
    if len(set(mapping.values())) != len(mapping):
        raise ValueError(f"{side}: target bone names are not unique")
    for old in mapping:
        armature.data.bones[old].name = renamed_bone_names[old]
        if mesh.vertex_groups.get(renamed_group_names[old]) is None:
            # Blender normally renames the matching group with its deform bone.
            # Preserve weights explicitly if the version's behavior differs.
            mesh.vertex_groups[old].name = renamed_group_names[old]
    old_objects = (armature.name, armature.data.name, mesh.name, mesh.data.name)
    armature.name = f"testing2-{side}-rig"
    armature.data.name = f"testing2-{side}-armature"
    mesh.name = f"testing2-{side}-mesh"
    mesh.data.name = f"testing2-{side}-geometry"
    return renamed_bone_names, renamed_group_names, old_objects


def restore_names(armature, mesh, rename_state):
    renamed_bone_names, renamed_group_names, old_objects = rename_state
    for old, current_name in renamed_bone_names.items():
        current = armature.data.bones.get(current_name)
        if current is not None:
            current.name = old
        group = mesh.vertex_groups.get(current_name)
        if group is not None:
            group.name = old
    armature.name, armature.data.name, mesh.name, mesh.data.name = old_objects


def run_export(source: Path, out_dir: Path, mapping_path: Path):
    if not hasattr(bpy.ops.export_scene, "gltf"):
        raise RuntimeError("Blender glTF exporter is not available.")
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    if mapping.get("schemaVersion") != 1 or set(mapping.get("sides", {})) != {"left", "right"}:
        raise ValueError("Mapping file must have schemaVersion=1 and exactly left/right sides.")
    meshes = {o.name: o for o in bpy.context.scene.objects if o.type == "MESH"}
    armatures = {o.name: o for o in bpy.context.scene.objects if o.type == "ARMATURE"}
    original_pose = {}
    original_multires = {}
    output_rows = []
    out_dir.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    original_frame = scene.frame_current
    try:
        scene.frame_set(0)
        for side in ("left", "right"):
            side_row = mapping["sides"][side]
            mesh = meshes.get(side_row["mesh"])
            armature = armatures.get(side_row["armature"])
            if mesh is None or armature is None:
                raise ValueError(f"{side}: source mesh or armature missing from scene")
            arm_mod = next((m for m in mesh.modifiers if m.type == "ARMATURE"), None)
            multi = next((m for m in mesh.modifiers if m.type == "MULTIRES"), None)
            if arm_mod is None or arm_mod.object != armature or multi is None:
                raise ValueError(f"{side}: mesh is not paired to the mapped armature through its Armature modifier and Multires")
            original_pose[armature.name] = armature.data.pose_position
            original_multires[mesh.name] = multi.levels
            rename_state = rename_for_export(armature, mesh, side_row, side)
            try:
                armature.data.pose_position = "REST"
                for level in range(multi.total_levels + 1):
                    multi.levels = level
                    bpy.context.view_layer.update()
                    reference_path = out_dir / f"rest-reference-{side}-L{level}-yup-f32.bin"
                    source_geometry = evaluated_counts(mesh, level, reference_path)
                    for selected_obj in bpy.context.view_layer.objects:
                        selected_obj.select_set(False)
                    mesh.select_set(True)
                    armature.select_set(True)
                    bpy.context.view_layer.objects.active = mesh
                    filename = f"testing2-{side}-multires-L{level}-4w.glb"
                    filepath = out_dir / filename
                    result = bpy.ops.export_scene.gltf(
                        filepath=str(filepath),
                        check_existing=False,
                        export_format="GLB",
                        export_skins=True,
                        export_def_bones=True,
                        export_rest_position_armature=True,
                        export_animations=False,
                        export_influence_nb=4,
                        export_all_influences=False,
                        export_apply=True,
                        export_yup=True,
                        export_materials="EXPORT",
                        use_selection=True,
                        use_active_scene=True,
                        export_cameras=False,
                        export_lights=False,
                        export_current_frame=False,
                    )
                    if "FINISHED" not in result or not filepath.is_file() or filepath.stat().st_size == 0:
                        raise RuntimeError(f"glTF export did not finish: {filepath} ({result})")
                    output_rows.append({
                        "side": side,
                        "multiresLevel": level,
                        "filename": filename,
                        "bytes": filepath.stat().st_size,
                        "sha256": sha256_file(filepath),
                        "multiresMaxLevel": multi.total_levels,
                        "sourceEvaluatedGeometry": source_geometry,
                        "skinInfluenceLimit": 4,
                        "sourceArmature": side_row["armature"],
                        "sourceMesh": side_row["mesh"],
                        "posePosition": "REST",
                        "sourcePoseSavedAs": "POSE",
                        "meshCut": False,
                        "forearmBonePreserved": "Bone.020",
                    })
            finally:
                restore_names(armature, mesh, rename_state)
        manifest = {
            "schemaVersion": 1,
            "tool": str(Path(__file__).resolve().relative_to(ROOT)).replace("\\", "/"),
            "blenderVersion": bpy.app.version_string,
            "source": {"path": str(source), "bytes": source.stat().st_size, "sha256": sha256_file(source)},
            "sourceSceneUnits": {"system": scene.unit_settings.system, "scaleLength": scene.unit_settings.scale_length, "label": "meters" if scene.unit_settings.system == "METRIC" and scene.unit_settings.scale_length == 1.0 else "Blender units"},
            "scaleInterpretation": "Source and GLB preserve the Blender scene metric scale. No physical hand-size, keyboard, wrist, or application-scale calibration was applied; the numeric unit label is provenance, not a claim of real-world fit.",
            "mapping": {"path": str(mapping_path), "sha256": sha256_file(mapping_path), "evidence": mapping.get("evidence")},
            "exportSettings": {"format": "GLB", "posePosition": "REST", "exportRestPositionArmature": True, "exportSkins": True, "exportDeformationBonesOnly": True, "exportAnimations": False, "exportInfluenceCount": 4, "exportAllInfluences": False, "applyNonArmatureModifiers": True, "exportYUp": True},
            "levels": "Multires L0 is the coarse source base mesh; L1/L2 are intermediate; L3 is the highest stored subdivision. No levels were reinterpreted as ready-to-ship LODs.",
            "geometryPolicy": "No clipping, surface decimation, or forearm cut. Multires evaluates the original skin weights at each level; Bone.020 forearm is retained.",
            "outputs": output_rows,
        }
        manifest_path = out_dir / "candidate-manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"CANDIDATE_MANIFEST={manifest_path}")
        for row in output_rows:
            print(f"EXPORTED {row['filename']} bytes={row['bytes']} sha256={row['sha256']}")
        return manifest
    finally:
        scene.frame_set(original_frame)
        for arm_name, pose_position in original_pose.items():
            arm = bpy.data.objects.get(arm_name)
            if arm and arm.type == "ARMATURE":
                arm.data.pose_position = pose_position
        for mesh_name, level in original_multires.items():
            obj = bpy.data.objects.get(mesh_name)
            if obj:
                multi = next((m for m in obj.modifiers if m.type == "MULTIRES"), None)
                if multi:
                    multi.levels = level
        bpy.context.view_layer.update()


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path, default=Path(bpy.data.filepath) if bpy.data.filepath else None)
    p.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    p.add_argument("--phase", choices=("analyze", "export"), default="analyze")
    p.add_argument("--mapping", type=Path)
    p.add_argument("--max-influences", type=int, choices=(4,), default=4)
    args = p.parse_args(argv)
    if args.source is None:
        p.error("Open a Blender source file or provide --source.")
    return args


def main():
    args = parse_args()
    source = args.source.resolve()
    out_dir = args.out_dir.resolve()
    scratch_root = (ROOT / "scratch" / "testing2-candidate").resolve()
    if not out_dir.is_relative_to(scratch_root):
        raise SystemExit(f"Refusing output outside {scratch_root}: {out_dir}")
    if not source.is_file():
        raise SystemExit(f"Source .blend not found: {source}")
    if bpy.data.filepath and Path(bpy.data.filepath).resolve() != source:
        raise SystemExit(f"Opened blend differs from requested source: {bpy.data.filepath}")
    if not bpy.data.filepath:
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False)
    if args.phase == "analyze":
        run_analysis(source, out_dir)
    else:
        mapping_path = args.mapping or (ROOT / "tools" / "testing2-candidate" / "bone-map.json")
        if not mapping_path.is_file():
            raise SystemExit(f"Mapping file not found: {mapping_path}")
        run_export(source, out_dir, mapping_path.resolve())


if __name__ == "__main__":
    main()
