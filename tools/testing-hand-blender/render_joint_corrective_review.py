"""Render matched source-skin versus neutral-clay Blender joint closeups.

Capture the identical real LOD0 hand geometry, camera and light with either
its original textured materials or a material override WITHOUT texture/normal
maps. LBS is shown at unsigned 0/30/60/90 degrees; DQS reference and the
*60-degree-only* bounded candidate are shown only at their authored 60 degrees.

At baseline LBS 60 degrees we additionally isolate color/roughness textures
from normal mapping by temporarily cloning original Blender materials: this
helps locate texture cracks before changing any source GLB or runtime model.

This is an offline shading-versus-geometry investigation, NOT a physiological
flexion sign calibration, anatomically correct contact test or export approval.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_mcp_comparison import (  # noqa: E402
    configure_render, locate, prepare_camera, look_at,
)

CASES = (
    ("ring-mcp", "ring-finger-phalanx-proximal", "pmcorr_ring_mcp_060"),
    ("pinky-dip", "pinky-finger-phalanx-distal", "pmcorr_pinky_dip_060"),
)


def runtime_reference_materials(mesh, manifest_path, side):
    """Construct Blender control shaders from EXACT WebGL manifest textures.

    Nodes are only a Blender approximation of the Three.js PBR shader, not
    a claim of pixel-identical materials. Nothing is saved to the GLB.
    """
    if not manifest_path.is_file():
        raise FileNotFoundError("Missing real WebGL runtime texture manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    if manifest.get("schemaVersion") != 1 or manifest.get("modelId") != "anatomical-improved":
        raise ValueError("Unexpected PianoMotion runtime texture manifest")
    lods = manifest["hands"][side]["lods"]
    lod0 = next((lod for lod in lods if lod["level"] == 0), None)
    if lod0 is None or lod0["textureSet"] != "high":
        raise ValueError("LOD0 must use the exact high-resolution runtime textures")
    info = manifest["textures"][lod0["textureSet"]]
    if (info["flipY"] is not False or info["baseColorColorSpace"] != "srgb"
            or info["normalColorSpace"] != "linear"
            or info["roughnessColorSpace"] != "linear"):
        raise ValueError("Unexpected Three.js texture orientation/color-space contract")
    if not mesh.data.uv_layers or mesh.data.uv_layers.active is None:
        raise ValueError("Real LOD0 hand is missing a UV map for runtime textures")
    root = manifest_path.parent.resolve()
    textures, texture_hashes, texture_paths = {}, {}, {}
    for key, cs in (("baseColor", "sRGB"), ("normal", "Non-Color"),
                    ("roughness", "Non-Color")):
        relative = info[key]
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise FileNotFoundError("Invalid or absent manifest texture: " + relative)
        image = bpy.data.images.load(str(path), check_existing=True)
        image.colorspace_settings.name = cs
        textures[key] = image
        texture_paths[key] = relative
        texture_hashes[key] = hashlib.sha256(path.read_bytes()).hexdigest()

    def make_material(mode):
        m = bpy.data.materials.new("PianoMotion runtime " + mode)
        m.use_nodes = True
        nodes, links = m.node_tree.nodes, m.node_tree.links
        nodes.clear()
        out = nodes.new("ShaderNodeOutputMaterial")
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        bsdf.inputs["Base Color"].default_value = (.58, .58, .58, 1)
        bsdf.inputs["Roughness"].default_value = .82
        bsdf.inputs["Metallic"].default_value = 0.0

        if mode in ("textured", "albedo-only"):
            albedo = nodes.new("ShaderNodeTexImage")
            albedo.image = textures["baseColor"]
            links.new(albedo.outputs["Color"], bsdf.inputs["Base Color"])
            rough = nodes.new("ShaderNodeTexImage")
            rough.image = textures["roughness"]
            scale = nodes.new("ShaderNodeMath")
            scale.operation = "MULTIPLY"
            scale.inputs[1].default_value = .52
            links.new(rough.outputs["Color"], scale.inputs[0])
            links.new(scale.outputs["Value"], bsdf.inputs["Roughness"])
        if mode in ("textured", "normal-only"):
            normal_image = nodes.new("ShaderNodeTexImage")
            normal_image.image = textures["normal"]
            nm = nodes.new("ShaderNodeNormalMap")
            nm.space = "TANGENT"
            nm.inputs["Strength"].default_value = .28
            links.new(normal_image.outputs["Color"], nm.inputs["Color"])
            links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        if mode not in ("textured", "albedo-only", "normal-only", "clay"):
            raise ValueError("Unknown diagnostic material mode " + mode)
        return m

    modes = {
        name: make_material(name)
        for name in ("textured", "clay", "albedo-only", "normal-only")
    }
    summary = {
        "manifestModelId": manifest["modelId"],
        "lod": 0,
        "textureSet": "high",
        "manifestPaths": texture_paths,
        "sha256": texture_hashes,
        "blenderMaterialIsThreeJsApproximation": True,
        "sourceTexturesMatchRuntimeManifest": True,
        "uvLayer": mesh.data.uv_layers.active.name,
    }
    return modes, summary


def main():
    rest = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--axes", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--side", choices=("left", "right"), required=True)
    params = parser.parse_args(rest)
    if not params.input.is_file() or not params.axes.is_file():
        raise FileNotFoundError("Missing real offline corrective .blend or matching axes")
    axes = json.loads(params.axes.read_text("utf8"))
    if axes["side"] != params.side or axes["schema"] != "testing-unsigned-hinge-axes-v1":
        raise ValueError("The visual review axes do not match this hand")
    if axes["anatomicalAxesCalibrated"] or axes["exportApproved"]:
        raise ValueError("Unapproved axes must not be represented as calibrated")
    axis_by_bone = {row["bone"]: row["axisBoneLocalUnsigned"] for row in axes["joints"]}
    bpy.ops.wm.open_mainfile(filepath=str(params.input.resolve()))
    arm, mesh, skin = locate()
    keys = mesh.data.shape_keys.key_blocks
    if keys is None:
        raise ValueError("Corrective .blend is missing the baked shape keys")
    if any(name not in axis_by_bone or keys.get(shape) is None
           for _, name, shape in CASES):
        raise ValueError("Missing measured rest hinge axes or baked corrective shapes")
    for key in keys:
        key.value = 0
    camera, _, lateral, normal, forward, framing = prepare_camera(arm, mesh)
    configure_render()
    # Keep camera/lighting constant across angle, material and deform variant.
    # Smaller clay captures offset the extra poses in the CI time budget.
    bpy.context.scene.cycles.samples = 8
    bpy.context.scene.render.resolution_x = 720
    bpy.context.scene.render.resolution_y = 720
    view_layer = bpy.context.view_layer
    old_material_override = view_layer.material_override
    if old_material_override is not None:
        raise ValueError("Cannot compare source materials with a nonempty view-layer override")
    source_materials = [slot.material for slot in mesh.material_slots]
    if not source_materials:
        raise ValueError("Expected imported GLB mesh to have material slots")
    reference_modes, runtime_material_metadata = runtime_reference_materials(
        mesh, params.manifest, params.side
    )
    params.output_dir.mkdir(parents=True, exist_ok=True)
    reports = []

    for short, bone_name, shape_name in CASES:
        joint = arm.pose.bones[bone_name]
        shape = keys[shape_name]
        axis = Vector(axis_by_bone[bone_name])
        if not all(math.isfinite(float(x)) for x in axis) or abs(axis.length - 1) > .001:
            raise ValueError("Invalid rest hinge axis: " + bone_name)
        if axis.x < 0:
            axis.negate()
        center = arm.matrix_world @ arm.data.bones[bone_name].head_local
        # Joint-side/palmar 3/4 view rather than a whole-hand shot: expose
        # crease compression and dorsal contour near the rotating phalanx.
        camera.location = (center + lateral * framing * .85
                           + normal * framing * .50
                           - forward * framing * .15)
        look_at(camera, center)
        camera.data.ortho_scale = max(.055, framing * .20)

        old_mode, old_rotation = joint.rotation_mode, joint.rotation_quaternion.copy()
        try:
            joint.rotation_mode = "QUATERNION"
            for degrees in (0, 30, 60, 90):
                # The candidate is fitted ONLY at 60 degrees. Rendering it
                # at 0/30/90 at full strength would be misleading evidence.
                joint.rotation_quaternion = Quaternion(axis, math.radians(degrees))
                variants = (
                    (("lbs", False, 0.0),
                     ("preserve-volume", True, 0.0),
                     ("bounded-corrective", False, 1.0))
                    if degrees == 60 else (("lbs", False, 0.0),)
                )
                for variant, preserve_volume, value in variants:
                    skin.use_deform_preserve_volume = preserve_volume
                    shape.value = value
                    modes = ["textured", "clay"]
                    if degrees == 60 and variant == "lbs":
                        # Isolate PBR color versus normal-chain artefacts
                        # without applying the 60-degree corrective at
                        # uncalibrated non-authoring poses.
                        modes += ["albedo-only", "normal-only"]
                    for material_mode in modes:
                        try:
                            # All four modes use the runtime manifest's
                            # external images, never accidental GLB materials.
                            reference = reference_modes[material_mode]
                            for slot in mesh.material_slots:
                                slot.material = reference
                            view_layer.update()
                            filename = (
                                f"{params.side}-{short}-{degrees:03d}-{variant}-"
                                f"{material_mode}-joint-closeup.png"
                            )
                            destination = params.output_dir / filename
                            bpy.context.scene.render.filepath = str(destination.resolve())
                            bpy.ops.render.render(write_still=True)
                            if not destination.is_file() or destination.stat().st_size < 15000:
                                raise ValueError(f"Missing real Blender joint render: {filename}")
                            reports.append({
                                "side": params.side, "bone": bone_name,
                                "morphName": shape_name, "variant": variant,
                                "materialMode": material_mode,
                                "image": filename, "jointBendDegrees": degrees,
                                "jointAxisSignedAndCalibrated": False,
                                "anatomicallyApproved": False,
                            })
                            print("[Testing joint material/pose render]", filename)
                        finally:
                            for slot, material in zip(mesh.material_slots, source_materials):
                                slot.material = material
                            view_layer.material_override = old_material_override
        finally:
            for slot, material in zip(mesh.material_slots, source_materials):
                slot.material = material
            view_layer.material_override = old_material_override
            shape.value = 0
            skin.use_deform_preserve_volume = False
            joint.rotation_quaternion = old_rotation
            joint.rotation_mode = old_mode
    if len(reports) != 28 or len({row["image"] for row in reports}) != 28:
        raise ValueError("Expected 28 unique real joint closeups per hand")
    output = params.output_dir / f"{params.side}-bounded-joint-review.json"
    output.write_text(json.dumps({
        "schema": "testing-joint-material-pose-blender-v3",
        "source": str(params.input), "side": params.side, "images": reports,
        "materialControl": (
            "source PBR vs neutral clay; at 60-degree LBS also source albedo"
            " without normal input and source normal chain without color texture"
        ),
        "runtimeMaterialReference": runtime_material_metadata,
        "geometrySourceUnchanged": True,
        "shaderVisualParityWithThreeJsCertified": False,
        "syntheticAxisBendOnly": True,
        "axisAnatomicallyCalibrated": False,
        "physiologicalFlexionSignCalibrated": False,
        "humanVisualReviewAccepted": False, "exportApproved": False,
    }, indent=2), encoding="utf8")


if __name__ == "__main__":
    main()
