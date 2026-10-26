# Testing hand — measured joint-local deformation priorities

**Date:** 26 October 2026. **Source:** real Blender LOD0 anatomical-improved GLB armatures, both hands, CI run [40383293628](https://github.com/shafranek-js/pianomotion-studio/actions/runs/40383293628).

**Research status, NOT human anatomical acceptance and NOT permission to export or deploy.** The visible Testing variant and original WebXR motion remain unchanged.

## Reproducible measurement

`tools/testing-hand-blender/measure_hinge_axes.py` derives **unsigned** candidate 3D hinge axes for all 12 MCP/PIP/DIP joints on index/middle/ring/pinky fingers in the native LOD0 rest armature. `measure_joint_local_deformation.py` independently poses *one joint at a time* by +60 degrees about the candidate local axis, then evaluates the **same mesh, same pose and same PM_MASK joint surface region** under Blender linear skinning (LBS) and Preserve Volume (dual quaternion skinning, DQS).

Each report records local RMS LBS↔DQS displacement in **millimeters**, along with local triangle area-collapse/expansion counts (area below 0.25× rest and above 2× rest). Both the prior artificial local +X axis and candidate axes are measured. Flexion sign, physiological constraints, piano key contacts and multi-joint combinations have **not** been validated. The DQS surface is a reference, not automatically the anatomically correct hand.

## Ranked regions — +60° geometric-axis synthetic pose

| Priority | Joint | Left local LBS–DQS RMS | Right local LBS–DQS RMS | Interpretation |
|---|---|---:|---:|---|
| 1 | Ring MCP | 2.319 mm | 2.319 mm | Largest local sensitivity to skinning method |
| 2 | Index MCP | 2.293 mm | 2.293 mm | High metacarpophalangeal volume difference |
| 3 | Middle MCP | 2.226 mm | 2.226 mm | High metacarpophalangeal volume difference |
| 4 | Ring PIP | 2.036 mm | 2.036 mm | Phalangeal hinge candidate |
| 5 | Index PIP | 2.036 mm | 2.036 mm | Phalangeal hinge candidate |
| 6 | Pinky MCP | 1.907 mm | 1.907 mm | Corrective may need asymmetric/mirrored validation |
| 7 | Middle PIP | 1.905 mm | 1.905 mm | Phalangeal hinge candidate |
| 8 | Pinky PIP | 1.584 mm | 1.584 mm | Phalangeal hinge candidate |
| 9 | Middle DIP | 1.342 mm | 1.342 mm | Local joint skin review |
| 10 | Ring DIP | 1.016 mm | 1.016 mm | Local joint skin review |
| 11 | Index DIP | 0.983 mm | 0.983 mm | Local joint skin review |
| 12 | Pinky DIP | 0.645 mm | 0.645 mm | **Separate collapse blocker despite small RMS** |

A low LBS–DQS RMS value **does not imply good quality**. With the measured unsigned axis, **pinky DIP LBS collapses 22 of 792 nearby triangles below one-quarter their rest area**, versus only **3 of 792 with DQS**. On the artificial local +X axis the corresponding LBS count is **42**, so axis selection itself matters. A 29.1° change in the unsigned axis estimate was previously measured for pinky DIP. This is not proof that either rotation sign or actual pivot is anatomically correct.

## Controlled next decisions

1. **Joint shape priorities:** Prototype *individual* ring/index/middle MCP volume and crease correctives first, with left/right and 30°/60°/90° pose pairs and neutral (=0) gates. Keep each in standalone Blender research assets.
2. **Collapse safety:** Evaluate pinky DIP separately using ratio <0.25, triangle inversion/orientation and joint-local silhouette; do not allow RMS ranking to hide the 22 severe collapses. Capture baseline vs candidate with two camera axes.
3. **Pivot calibration:** Review the real 3D bone-head locations and signed physiological flexion axes before sculpting/approving correctives. Thumb CMC/opposition is a separate model and not covered by these 12 finger axes.
4. **Runtime surface:** Require LOD0/1/2 vertex-local equivalent morphs, four-bone normalized skin weights, no worsening of other joints, correct key-top contact and identical WebXR bone motion. An experimental GLSL/different DQS implementation must be re-tested in actual Three.js; Blender Preserve Volume is **not** provided automatically by glTF.
5. **Acceptance:** Four-model matched note/fingering evidence, full-precision images POV/Side Arch/Overhead/Concert, actual piano passages, both hands and exported video. Never use one synthetic 60° pose as a pass/fail acceptance of a pianist's hand.

## Files and reproducibility

- `tools/testing-hand-blender/measure_hinge_axes.py`
- `tools/testing-hand-blender/measure_joint_local_deformation.py`
- `.github/workflows/testing-hand-blender-real.yml`
- GitHub Actions artifact `testing-hand-blender-lod0-authoring-<run-number>` includes `left-joint-local-deformation.json` / `right-joint-local-deformation.json` for independent inspection.
- Recorded test run: [40383293628](https://github.com/shafranek-js/pianomotion-studio/actions/runs/40383293628).

**Decision:** The geometric-axis deformation survey is successful and useful for prioritization, but no correction is enabled in the user-facing Testing model. It remains an unmerged Draft PR experiment.
