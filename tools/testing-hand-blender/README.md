# PianoMotion Studio — Testing hand corrective authoring

**Status: Blender preparation only. No corrective has been sculpted, exported, or approved.** The current Testing model keeps the existing WebXR motion and digit-aware LOD surface. Nothing here changes main or the production deployment.

The numerical QA pinpoints many distortions around the **index/middle MCP and metacarpal transitions**, **wrist**, and **thumb base**. The next skinning step is explicit, *per joint*, and must be checked in a real Blender rig; blanket smoothing has already failed.

## 1. Source assets

Use the rigged anatomical-improved GLB files already in this repository:

- `apps/client/public/models/hands/improved/left-lod0.glb`
- `apps/client/public/models/hands/improved/right-lod0.glb`

They contain the 25 expected joint names. LOD0 (~35k triangles) is the primary sculpt source; later derive and verify matching morph targets for LOD1 and LOD2. **Do not use `hand_standard.glb` with this script:** that standalone photo-realistic source has no skin or armature. It must first pass the separate draft Blender rigging/weight painting workflow. Avoid committing the original 79 MB model or restricted third-party scans by accident.

## 2. Prepare independent left/right sculpt sessions

From the repository root, on a workstation with **Blender 4.x** available:

```powershell
blender --background --python tools/testing-hand-blender/prepare_corrective_sculpt.py -- --side left --input apps/client/public/models/hands/improved/left-lod0.glb --output-blend scratch/testing-hand-left-sculpt.blend --report scratch/testing-hand-left-sculpt.json

blender --background --python tools/testing-hand-blender/prepare_corrective_sculpt.py -- --side right --input apps/client/public/models/hands/improved/right-lod0.glb --output-blend scratch/testing-hand-right-sculpt.blend --report scratch/testing-hand-right-sculpt.json
```

Blender must report one armature with the expected named joints and one bound mesh. No rig or absent native vertex groups is a **hard error**. The input GLB remains unchanged.

The script creates **48 empty, localized sculpt slots**: thumb CMC/MCP/IP; four fingers × MCP/PIP/DIP; wrist; each at 30°, 60° and 90°. For example `pmcorr_index_mcp_030`, `pmcorr_middle_pip_060`, `pmcorr_thumb_cmc_090`, `pmcorr_wrist_flex_030`. It generates masked groups `PM_MASK_<bone-name>` using the joint location and native bone weighting, and a JSON report with mask coverage and sculpted-vertex counts.

**Important:** Every new target starts identical to the Basis. This is an authoring scaffold, **not** an already fixed hand. Do not export or deploy an unchanged shape key as an anatomical corrective.

## 3. Review in Blender

1. Open the generated `.blend`. Verify the wrist and each thumb/finger joint **head and roll** against the hand surface. This step is critical; imported GLB rotations and common internet hinge axes may be unsuitable.
2. Pose exactly one joint at 30°, 60° and 90° using the hand's **calibrated local flexion axis**. Do **not** blindly rotate around local X. Respect finger extension, abduction/adduction and thumb CMC opposition.
3. Select the corresponding shape key and sculpt a corrected rest-relative shape so that, once skinned, the dorsal knuckle, volar finger pad and webbing remain credible. Avoid triangular pinching and loss of phalanx volume.
4. The `PM_MASK_*` vertex groups are **only sculpting aids**. The glTF exporter may not preserve Blender's masked shape-key influence. The corrected positions must be **baked into actual morph deltas** outside the masked region (zero outside) before export.
5. Compare silhouette and worst triangles under the same pose as WebXR/Testing. Do the left and right hands separately; do not assume shape coordinates can be mirrored without recomputing rig transforms.
6. Use the JSON report to identify blank slots. No "corrective ready" status is awarded based merely on creating keys.

## 4. Future export contract

A finished GLB must retain: original anatomical UV/PBR skin, 25 named bones, inverse bind matrices, 4 finite normalized influences/vertex and identical topology between Basis and morph targets. The exported morph target names must match the `pmcorr_*_(030|060|090)` convention.

Blender shape-key drivers/pose actions are **not** assumed to survive glTF export. Three.js will evaluate bend-dependent morph weights explicitly. The pose evaluator must interpolate 0→30→60→90 without discontinuities and distinguish true flexion from hyperextension once joint axes are calibrated.

Run on **both hands and all three LODs** before attaching any morph to visible Testing. Validate geometry limits, black/white-key contact, long playback, 25-bone WebXR pose parity and exported video. No merge until visual acceptance.

## 5. Known environment limitation

The development container used to prepare this code has Python and Node but **does not contain Blender**, so the `.blend` generation and deform sculpts cannot be truthfully claimed complete. Source can be syntax-checked by CPython, but Blender execution and human review need Blender 4.x on an authorized workstation.

Related studies: [research & engineering plan](../../docs/RESEARCH_PIANIST_HANDS_2026-10-26.md), [testing experiment notes](../../docs/TESTING_HAND_EXPERIMENT.md).
