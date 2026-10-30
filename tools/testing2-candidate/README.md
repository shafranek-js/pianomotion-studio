# Testing2 hand candidate preparation

This tool builds disposable, side-specific GLB candidates from the downloaded
`Hands + armature.blend`. It does not edit or save the `.blend`, change project
dependencies, or copy any candidate into application assets. Export candidates are
experimental inputs for later visual and retarget evaluation.

## Reproduce on this checkout

Run from the repository root in PowerShell. Set `$Source` to the downloaded
source `.blend` path; the Blender executable and adjacent license file must be available.
The default output directory is `scratch\testing2-candidate`.

```powershell
$Blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
$Source = '<path-to-Hands + armature.blend>'
$Out = '.\scratch\testing2-candidate'

& $Blender --background $Source --python '.\tools\testing2-candidate\blender_candidate.py' -- --phase analyze --out-dir $Out
if ($LASTEXITCODE -ne 0) { throw 'Blender source inventory failed.' }

& $Blender --background $Source --python '.\tools\testing2-candidate\blender_candidate.py' -- --phase export --out-dir $Out --mapping '.\tools\testing2-candidate\bone-map.json'
if ($LASTEXITCODE -ne 0) { throw 'Blender candidate export failed.' }

$Glbs = Get-ChildItem -LiteralPath $Out -Filter '*.glb' | Sort-Object Name | Select-Object -ExpandProperty FullName
& node '.\tools\testing2-candidate\validate_runtime.mjs' $Glbs
if ($LASTEXITCODE -ne 0) { throw 'Three.js GLB round-trip validation failed.' }
```

No package installation is required. The runtime check imports the repository's
existing Three.js 0.186.1 `GLTFLoader`.

## Outputs

`blender_candidate.py --phase analyze` writes `source-inventory.json`. It records
source hashes, both rigs and constraints, each multires level, saved-pose versus
REST surface displacement, the local license evidence, and every source vertex
with more than four assigned bone groups (including its index and group weights).

`--phase export` writes eight side-specific GLBs, `candidate-manifest.json`, and
Float32 reference point clouds for the evaluated Blender REST meshes. The cloud is
in glTF Y-up coordinates and allows the runtime check to compare every imported
skinned vertex with the matching source vertex after coordinate conversion.

`validate_runtime.mjs` writes `runtime-roundtrip.json`. It parses each GLB through
Three.js, checks skin attributes and joint references, checks normalized four-slot
weights, compares every skinned REST vertex to the Blender reference cloud, checks
scene scale before/after axis conversion, and rotates/restores a mapped finger bone
as a small skin-response probe.

| Multires level | Meaning in source | Vertices / triangles per hand | Left GLB bytes | Right GLB bytes |
|---:|---|---:|---:|---:|
| L0 | Coarse base mesh | 1,102 / 2,178 | 92,792 | 70,524 |
| L1 | Intermediate | 4,383 / 8,716 | 342,016 | 254,124 |
| L2 | Intermediate | 17,481 / 34,864 | 1,337,192 | 987,336 |
| L3 | Highest stored subdivision | 69,825 / 139,456 | 6,151,504 | 4,754,768 |

L0 is the source base mesh and L3 is the highest stored subdivision. These level
labels do not claim that any candidate is a finished or accepted runtime LOD.

## Decisions and evidence

- `Hand.L` is paired to `Hand_Left`; `Hand.R` to `Hand_Right`, based on each
  mesh's explicit Armature modifier target.
- Each GLB contains one skinned hand, 22 deform bones, and no non-deforming control
  bones. Bone names are derived from the verified parent chains. Thumb bones
  `.018` and `.019` remain separate distal segments; no thumb DIP or tip bone is
  invented. The thumb anatomical labels have moderate confidence.
- The forearm remains part of the source geometry and is retained as its own
  `left_forearm` or `right_forearm` deform bone. No wrist cut, mesh separation, or
  boundary cap is attempted.
- Export sets both armature pose mode and glTF rest-position export to REST,
  disables animation export, evaluates Multires, uses the original vertex-group
  assignments as input, and asks Blender to export at most four influences.
  Blender reports that the four highest weights are selected and normalized.
- Source inventory reports 43 left and 39 right base-mesh vertices with more than
  four assigned groups. Their exact indices and weights are in
  `source-inventory.json`. The GLB checks confirm valid normalized four-slot skin
  data; they do not establish that dropping the lower source influences has no
  visual or retargeting cost.
- The source has no Actions. Its saved state is a non-neutral evaluated POSE:
  mean vertex displacement versus REST is 0.059231 source-scene meters on the left
  and 0.440506 on the right (P95 0.144102 and 0.505902; maximum 0.178607 and
  0.520424). The exports use the actual evaluated REST surface.
- Blender copy-rotation and IK constraints are not represented by glTF. The
  terminal IK targets are null, so the Blender controls are not a usable runtime
  retarget contract by themselves.
- The left mesh has one `Col` corner color attribute; the right has none. Left
  GLBs contain `COLOR_0` and `COLOR_1`, while right GLBs have no color attributes.
  The source material has no image node or vertex-color node, and Blender logs
  that the active color is not used by the material tree. Visual display of these
  extra channels still needs inspection in the intended renderer.
- The scene declares metric units with `scale_length=1.0`. No global scale,
  keyboard alignment, wrist centering, or application calibration is applied.
  The glTF numeric scale matches the source to about 0.0002%; these dimensions
  include the forearm and do not claim a physical hand size or keyboard fit.
- The adjacent `92895 - LICENSE.html` identifies Blend Swap #92895, “Human Hands
  with armature,” under CC0 1.0 and says there are no license requirements. This
  is local-file evidence; the public page was not independently rechecked.

## Current verification result

On Blender 5.2.3 LTS and Three.js GLTFLoader 0.186.1, all eight GLBs pass the
current runtime checks. Every imported mesh has 22 joints and four joint/weight
slots; maximum weight-sum error is at most `5.2e-8`. Invalid, zero-weight, and
more-than-four-influence runtime vertices are all zero. Bone-rest matrix identity
error is at most `1.14e-5`. Per-index REST surface error versus the Blender reference
is `7.0e-6` to `7.4e-6` source-scene meters. Sorted bounds differ by at most
`5.5e-6` source-scene meters and diagonal scale ratio is `1.0000015`–`1.0000018`.
The 0.1-radian index-proximal probe moves weighted vertices by `0.0159`–`0.0216`
source-scene meters and returns to zero measured drift. These are exporter/runtime
consistency checks; they do not verify product-scale calibration, visual quality,
full retargeting, device performance, or the deformation impact of influence loss.

## Additional controlled skinning investigation

The separate Blender investigation under `scratch/candidate-visual-qa-20261028/`
compared the source's full vertex weights against the four strongest weights,
renormalized on identical copies of the source meshes. At Multires L3, the worst
vertex difference in the tested all-finger diagnostic bend was approximately
`0.00356` source world units, and the worst RMS difference was approximately
`0.000158` units. The source scale has not been calibrated to the keyboard, so
these values are not physical millimeter errors. See `skin-error-4influence.json`,
`skin-error-authored-frame.json`, and the investigation README for poses and
reproduction commands. These samples do not cover all playback poses or establish
the quality of the exported skinning throughout a piece.

## MotionPose retarget experiment

`scratch/testing2-candidate/retarget-prototype.mjs` is an isolated matrix-fit
experiment using the engine-generated pair of hand poses for Habanera at 49 s
and the L3 candidates. Run it with `node scratch/testing2-candidate/retarget-prototype.mjs`.
Its JSON report keeps the captured right-hand fixture separate, since it does not
match the generated paired pose. The experiment fits segment endpoints by setting
world transforms and allowing per-segment scale, translation and parent-local
shear. The near-zero endpoint residual verifies the coordinate/matrix calculation;
it is not evidence of an anatomically valid pose, pad contact, or playable result.
The report explicitly marks `retargetQualityAccepted: false`.

After a single illustrative wrist-to-middle-tip chord calibration for each hand,
the candidate's segment ratios to the selected pose still range from about
0.53 to 3.47. The source and target joint conventions may differ, and the target
chord is measured in a bent pose, so these numbers are diagnostics, not an
anatomical measurement or a final sizing recommendation. A constrained, fixed-length
retarget and surface/contact evaluation are required before any app integration.

An additional direction-following rotation-only probe can be run with
`node scratch/testing2-candidate/rotation-only-retarget-check.mjs`. It preserves
finger bone lengths and local translations after the same uniform chord calibration,
anchors the wrist, and rotates the source chains toward the target directions. In
this one pose, its maximum joint-target discrepancies were about 66 mm left and
69 mm right. This is a negative result for that specific simple mapping, not a
general proof that fixed-length IK cannot fit the model: the solver does not
optimize the palm, wrist orientation, joint targets or contact, and the source and
MotionPose landmarks are not yet validated as equivalent. The separate forearm
cuff target is also substantially different. See the rotation-only JSON report
for the method and per-joint results. Neither experiment is live playback.
