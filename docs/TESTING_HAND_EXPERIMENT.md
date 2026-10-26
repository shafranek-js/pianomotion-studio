# Testing hand — WebXR kinematics with anatomical appearance

Status: **experimental, not visually accepted**. Existing `WebXR`, `Anatomical (Realistic)` and `Anatomical (improved)` models are untouched. Default remains `Anatomical`.

## Objective

Test the user's desired combination:

- **Motion:** exact WebXR motion targets, wrist trajectory, bone orientations, hover behaviour, per-finger movement and existing note sequencing.
- **Surface:** existing anatomical-improved realistic hand geometry, UVs, normals, fingernails and high-resolution PBR textures.
- **Skinning:** in a one-time runtime initialization pass, sample WebXR's trusted skin weight field onto the anatomical surface, rather than using the anatomical GLB's estimated weights, which have produced palm/wrist spikes and twisted thumb webs.

## Implementation

`settings.handModel = "testing"` is a fourth, opt-in model in all six UI locales.

`testingHandSkin.ts`: builds a spatial index of WebXR **bind-pose vertices**, interpolates the closest reference vertices' `JOINTS_0`/`WEIGHTS_0` onto the anatomical shell, retains at most four influences and normalizes them. It copies the anatomical geometry (positions, UVs, normals and indices) without changing the existing GLB files. Source and target are both transformed into the same **inch-space** when parsed. No CPU skin update is added to the animation loop.

`buildTestingHandRig` makes the WebXR skeleton and inverse bind matrices the deformation rig and installs the anatomical mesh as its skinned surface. That is a deliberate alternative to the improved model's re-estimated carpal anchors and pose-dependent axial length fitting. Regular WebXR motion (including hover and tip correction) remains in effect. Unlike `anatomical-improved`, Testing does not independently solve fingertip contact after the fact.

The detailed hand manifest, shared texture cache, async loading/retry, LOD selection, left/right assets, and deterministic highest-LOD export path are reused, including fallback when loading fails. The original model IDs/assets/default stay unchanged.


## Matched four-model browser evidence (26 October 2026)

The Playwright case `Testing hand: matched WebGL model and camera evidence`
runs independently for four models: `webxr`, `anatomical`,
`anatomical-improved`, `testing`. Each uses the same two-hand MIDI,
settled performance plan, 1280×800 viewport, and the same requested
musical position. Each shard verifies BOTH hands have loaded the requested
model without silently falling back.

**CI quick evidence (default):** score position **0.75 s**, views
**Pianist POV** and **Side Arch** (2 PNGs per model, 8 total across four
separate artifact ZIPs). This is deliberate: the original four-model
48-frame test timed out on SwiftShader before emitting complete evidence.
The initial failure run `40368626896` still saved partial screenshots, but
**all four cases failed**, so those files alone do not constitute a passed
visual comparison.

**Extended inspection (opt-in):** with
`PIANOMOTION_EVIDENCE_FULL=1`, capture positions 0.75/3/6 s and
Concert/Overhead/POV/Side Arch, totaling 12 PNGs per model (48 across
four shards). It is not part of the standard PR gate because a CPU
software-GPU capture can exceed the browser-test deadline.

Each shard writes `testing-hand-evidence.json` and
`testing-hand-review.html`; images are named
`testing-ab-<model>-<camera>-<time>s.png`. To compare the four models,
extract all **four** artifact ZIPs into the same directory or compile an
offline contact sheet. Do not report 48 complete images if some cases
fail or a shard captures only the quick subset.

The matched-image job **does not perform a 20/80-frame playback benchmark**:
`requestAnimationFrame` under headless SwiftShader caused timeouts even
after successful screenshots. Animation/renderer counters and contact
quality require an independent bounded playback and real-device check.
Static screenshots prove neither anatomical realism nor continuous
fingering motion. Preserve the PR as draft until visual acceptance.

GitHub Actions workflow: `.github/workflows/testing-hand-pr.yml`.
Browser test: `tests/browser/anatomical-improved.spec.ts`.

## Thumb bind-frame proportional calibration — research candidate (26 October 2026)

The user identified an oversized-looking thumb and angular webbing specifically in
**Testing**, not in Anatomical (improved). The two rest GLBs do not have
interchangeable segment lengths. Measurements on the **right LOD0**
source-derived anatomical bind skeleton versus right.glb WebXR bind:

| Bone segment | Anatomical source-derived | WebXR | WebXR / anatomical |
|---|---:|---:|---:|
| Thumb metacarpal → proximal | 5.41 cm | 3.25 cm | 0.60 |
| Thumb proximal → distal | 2.87 cm | 3.38 cm | 1.18 |
| Thumb distal → tip | 1.12 cm | 1.49 cm | 1.33 |

The original complete hand_standard.glb is not committed here. This measurement
is derived from the LOD0 model built from that source using a single global
similarity transform; it is **not** a direct raw-file inspection.

`testingHandBoneFrameTransfer.ts` now has an **experimental, opt-in
`thumbAxialScale`** mode that maps anatomical query positions to their
counterpart WebXR bind frames, scaling *only the thumb bone-local longitudinal
query coordinate* by the measured segment ratio. The anatomical
`POSITION`, `NORMAL`, `TEXCOORD_0`, texture data, index topology, original
GLBs, WebXR joint transforms and musical motion remain unchanged.
There is no thumb-size slider or user-visible activation.

The real-GLB tests compare both hands at LOD2, validate finite ratios,
normalized weights, no foreign-digit contamination and unchanged positions.
The pose test also logs **thumb-only** collapsed/expanded triangle counts and
maximum severity alongside full-hand metrics for the existing and calibrated
weight fields at matched MotionPoses.

**Critical A/B methodology:** the initial hotspot experiment grouped triangles
by each candidate's transferred WebXR bone weights, producing *different*
thumb triangle counts (e.g. left 1,276 vs 1,521). Those figures are NOT
apples-to-apples evidence of a visual improvement. The revised
`testingHandThumbQA.ts` selects thumb triangle IDs exclusively from the
**unchanged native GLB bone names and weights** and asserts identical topology,
vertices and triangle counts for both algorithms. The revised CI report is the
source of truth for a decision. Even the initial non-comparable measurements
showed increased deformation for the right hand and worse global area P95.
Do not enable the new weight field based on those early numbers.

This is a *candidate*, **not a fix yet**. Its acceptance must be based on
pose-local improvement at neutral, thumb-under, 30/60/90° bends, both hands,
all LODs and a rendered human review. Worse deformation or unacceptable
fingertip positioning rejects the candidate. Existing Testing remains
unchanged while those gates are incomplete.

## Acceptance required (not yet performed)

1. Confirm the `Testing` option persists on refresh, selects correctly, switches back safely, and works with **both hands**.
2. Capture same note/time, camera, skin style and lighting for **WebXR**, **Anatomical (Realistic)**, **Anatomical (improved)** and **Testing**. Use Concert, POV, Overhead and Side Arch with close-ups of all digits.
3. Reject if any angular thumb-web folds, exploding spikes, interpenetrating fingers, plastic gloss, broken fingernails, wrist seams, detached sleeve, incorrect normals or skin inversion appears.
4. Run still poses at neutral, 30/60/90-degree flex, thumb-under, black and white key contacts, octaves and tenths, and continuous musical playback/seek/reverse/repeat.
5. Verify LOD0/1/2 transitions have no hand pose pops, resource leaks or large frame spikes. Log p50/p95 frame times on desktop and actual weaker physical hardware.
6. Verify exported MP4/WebM frames match live Testing and that a model loading error cannot silently switch to another model during export.
7. Track WebXR reference bone orientation vs anatomy mesh bind orientation and distances, particularly at thumb CMC and ulnar wrist. If Testing still deforms unnaturally, next iteration should use a **surface-cage or per-finger geodesic weight transfer**, with manually reviewed cut line and corrective blendshapes; do **not** conceal defects with a material shader.

## Known limitations

- This is a spatial vertex-based approximation, not a verified anatomical retopology or fully sculpted deformation rig.
- Close or overlapping fingers may share neighboring WebXR reference vertices; weight transfer can still leak across anatomical boundaries.
- The source mesh geometry is not yet reprojected onto the WebXR bind axes with per-phalange cage correspondences. Geometric registration between the two rest poses must be verified.
- Face topology and joint crease loops have not been manually accepted.
- Existing asset licensing/provenance restrictions still apply (see `docs/PROVENANCE.md`).

Do not merge to `main` or deploy Testing before a rendered-image review and typecheck/unit/browser gates. This branch is a **research preview** intended for user comparison, not a claim that deformation quality is solved.
