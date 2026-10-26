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

## Unsigned MCP/PIP/DIP axis survey (research gate)

The real Blender CI also runs `measure_hinge_axes.py` on *both* imported
LOD0 armatures and writes `left-unsigned-hinge-axes.json` and
`right-unsigned-hinge-axes.json`. It records all 12 MCP/PIP/DIP axes
as bone-local unit vectors derived from the palm plane and each finger's
actual rest centerline. It reports their angular disagreement with the
previous synthetic local-X rotation and fails on missing/degenerate joints.

**These are unsigned geometric candidates, not calibrated anatomical axes.**
No thumb CMC opposition axis or physiological bend sign is inferred. The
existing synthetic local-X morph remains an offline benchmark only; the
new estimates do not alter Testing, Blender shape keys or source GLBs.
Manual pivot/sign calibration and visual DQS/LBS/reconstructed-GLB testing
are required before using these axes for corrected skinned movement.

## Joint-by-joint deformation priority (research only)

`measure_joint_local_deformation.py` reads the previously generated unsigned
rest-axis report and evaluates each of the 12 finger MCP/PIP/DIP joints with
the same 60° diagnostic rotation using both LBS and Blender Preserve Volume.
The supplied `PM_MASK_*` masks restrict RMS displacement (in millimeters) and
triangle area-collapse/expansion counts to a joint-local surface region.
Both previous synthetic local +X and estimated per-joint rest axes are
included, with the signed direction chosen closest to local +X for an
apples-to-apples experiment.

Reports `left-joint-local-deformation.json` and
`right-joint-local-deformation.json` rank the joints by their local
LBS-to-DQS differences. They are **prioritization diagnostics**, not evidence
that DQS is anatomically correct, not calibrated flexion, and not an approved
GLB corrective. A human must review axes, visual bends, key contact and
actual piano motions before any morph is enabled.

## Measured-axis candidate morphs (not enabled)

The independent Blender job runs `prototype_joint_correctives.py` on each
LOD0 hand, with the generated unsigned-axis JSON, to create FOUR nonzero
prototype keys: ring/index/middle MCP at 60° and pinky DIP at 60°.
It analytically inverts the same Blender LBS model to approximate the
diagnostic Preserve Volume deformation in the *local sculpt masks*,
clamping rest-space deltas to 4 mm. A report includes RMS distance to DQS,
local quarter-area collapses under LBS/DQS/candidate, changed-vertex counts,
and an explicit boolean indicating **whether the candidate worsened severe
collapse**. Improved DQS RMS is a *research gate only*, not anatomical proof.

The output `left-measured-joint-candidates.blend` and
`right-measured-joint-candidates.blend` remain offline artifacts.
The hinge axis direction and physiological flexion sign are unverified;
thumb opposition, surface contact, multi-joint poses and LOD1/LOD2 remain
unverified. Do **not** add these shape keys to the visible Testing model or
publish experimental GLBs until those gates pass.

## Joint-specific corrective strength safeguard

The experimental 60° candidate bake now tests 100 strengths (0.01–1.00)
per joint and selects the best LBS→DQS RMS fit **only among amplitudes
that do not increase local triangles below 25% or 50% of rest area**.
The selected fraction is baked into the actual Blender shape-key vertex
coordinates; an independent posed Blender evaluation must reproduce the
predicted RMS and collapse counts. The JSON retains the unrestricted
candidate metrics, chosen fraction, baseline and bounded result.
If no nonzero safer candidate exists, the CI fails rather than accepting
a visually riskier morph. This diagnostic safeguard **does not** validate
biomechanics, key contact, collisions, 0/30/90° bends or LOD1/LOD2.

## Side-by-side real Blender visual proof

The first 60° A/B/C comparison of ring MCP and pinky DIP showed dark
jagged, seam-like creases already visible on uncorrected LBS and DQS.
Those frames do **not** identify the cause: original source textures,
normal maps, surface normals, geometry and intersection artefacts must
not be conflated.

The follow-up `render_joint_corrective_review.py` produces **24 real
closeups per hand** (48 total), with the **same source mesh, camera and
lighting** per joint:

- Unsigned joint bends at **0°, 30°, 60° and 90°** for baseline LBS.
- At the candidate's authored **60° only**: additional Preserve Volume
  (DQS reference) and bounded-corrective comparisons. No off-pose
  application of the fixed 60° morph is passed off as evidence.
- Each pose/variant rendered twice: **original textured material** and
  **neutral rough clay** with no material normal-map node. The clay is
  applied as a temporary view-layer material override; it does not
  edit mesh positions, material slots, UVs or source GLBs.
- Camera orthographic scale is reduced for a more useful joint closeup.

The `*-bounded-joint-review.json` manifest (schema
`testing-joint-material-pose-blender-v2`) identifies every angle,
variant, material mode and the lack of anatomical calibration/approval.
The GitHub Actions job rejects missing images, incomplete angle/material
pairs and incorrect off-60° corrective claims.

**Interpretation:** seams that appear in both textured and neutral-clay
captures motivate a closer look at topology, shading normals and
skin-induced geometry. Disappearance in clay suggests investigating
textures, shader normal maps or material setup, but is *not proof* of
a single root cause. Unsigned 0–90° rotations are merely controlled
diagnostic probes, **not confirmed physiological flexion**.

The Blender CI packs a standalone `render-review/index.html` gallery
alongside the 48 actual PNG frames. Download and extract the complete
`testing-hand-blender-lod0-authoring-*` workflow artifact, then open
`render-review/index.html` locally. Each synthetic bend has a directly
paired original-skin and clay view; 60° also displays the three deformation
variants. The gallery generator refuses to build if either hand, angle,
material or source render is missing. It does not synthesize or retouch images.

These frames do not replace visual motion acceptance on both hands with
real MIDI, multi-joint/thumb opposition poses, full LOD checks, key
contact or export. **Do not merge PR #9 or ship corrected GLBs.**


## Material source isolation — real Blender evidence (26 October 2026)

The finished real-LOD0 job [40391388316](https://github.com/shafranek-js/pianomotion-studio/actions/runs/40391388316)
produced **48/48** frame references (two hands, ring MCP and pinky DIP,
0/30/60/90° baseline LBS, 60° LBS/DQS/bounded-corrective). The gallery
is `render-review/index.html` inside the workflow artifact. A direct
visual review showed the irregular dark hairline cracks scattered over the
finger and hand surface almost disappear under neutral clay, including
in the baseline. This **implicates the source PBR material stack, but does
not yet distinguish albedo, normal/bump, roughness or mixed shading**.
The prominent folded, pinched membrane at the **left ring MCP** persists
under clay across LBS/DQS/bounded-corrective. That problem is geometric;
the current bounded corrective is **not an accepted fix**.

The next offline run splits the diagnostic materials at **60° LBS only**:

- `textured`: untouched original PBR material.
- `clay`: neutral, rough material without any shader texture normals.
- `albedo-only`: source material copies keeping original color/roughness,
  disconnecting Principled BSDF Normal input.
- `normal-only`: source material copies retaining the original shader
  Normal chain while replacing Base Color, roughness and metallic inputs
  with neutral values.

Temporary material copies are assigned only in the Blender rendering
session; the original `.blend`, GLBs and runtime models are not modified.
Original material graph metadata records which slots had Base Color and
Normal links. For each hand, the review expands from 24 to **28 frames**
(**56 total**), and CI checks each exact material/pose/variant combination.
Do not attribute the defect to normal maps or color texture until the new
comparison has been rendered and inspected; other shader graph inputs may
remain. No uncalibrated pose is treated as physiological flexion.

## Exact fold-polygon attribution (offline, not applied)

The real LOD0 diagnostic `analyze_fold_polygons.py` runs separately for both
hands on the generated measured-axis corrective Blender projects. It bends
**only ring MCP or pinky DIP to the uncalibrated 60° axis**, then measures
the *same original polygon IDs* in LBS and the 60° bounded-corrective pose.
The resulting `left-fold-hotspots.json` / `right-fold-hotspots.json` record:

- Top 12 collapsed-area, expanded-area and collapsed-edge triangles per
  joint/variant, by **original mesh polygon and vertex index**.
- Rest and posed local-space centroids, area ratios, edge-length ratios,
  and top contributing native bone vertex groups (excluding sculpt masks).
- Exact joint mask and affected polygon coverage, left/right independently.

The output is a reproducible **artist/engineering inspection list** for
targeted skin weight paint and geometry repair. A triangle-area metric alone
does not certify a fold as incorrect: the screenshots already show that
left ring MCP's physically implausible fan-like pinches persist in clay.
Inspect those source polygon IDs in Blender before editing any vertex.

This report does **not** reweight skin, sculpt the correction, alter source
GLBs, calibrate bend sign, confirm pianist movement or approve export.

## Worst-triangle safeguard — independent from collapse counts

Real LOD0 60° candidate reports revealed that the index MCP's **smallest**
triangle area ratio deteriorates **0.4680 → 0.2573**, while the count
of below-half triangles stays **7 → 7**. Aggregate RMS and simple threshold
counts miss this deformation.

Candidate reports now include `worstAreaRatioDelta` and
`worstAreaRatioNonRegression`. CI checks these against the actual Blender
geometry and logs a **reject for runtime** warning when the local minimum
regresses. This does not fail offline rendering: the unsafe candidate is
retained for visual comparison, not for runtime use. The existing export
and human-acceptance gates stay closed. A minimum ratio alone does not
certify anatomically natural bending.
