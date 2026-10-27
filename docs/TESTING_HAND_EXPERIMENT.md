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

**Matched-triangle quantitative results** (real left/right LOD2, same 972
native thumb triangles per hand, synthetic pose, hover=0):

| Metric | Left current | Left full axial | Right current | Right full axial |
|---|---:|---:|---:|---:|
| Collapsed area below 0.25× | 43 | 20 | 10 | 2 |
| Expanded area above 2× | 10 | 12 | 5 | 23 |
| Worst area severity | 41.47 | 13.86 | 13.71 | 4.74 |
| Full-hand edge stretch P95 | 1.611 | 1.746 | 1.407 | 1.495 |

Although worst individual area severity improves, the full-correction variant
**fails release acceptance** because severely expanded thumb faces increase
(especially right), and global stretching increases. The follow-up A/B
sweeps **0.25/0.50/0.75** partial longitudinal calibration strengths, measuring
the same immutable anatomical triangle set and entire hand. An intermediate
variant remains research-only until it improves BOTH hands without new spikes,
passes multi-pose/LOD/contact/visual acceptance, and does not change WebXR
motion. No live Testing activation is authorized by these metrics.

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

## Live Testing thumb A/B (27 October 2026 preview)

Preferences → Hand Model → Testing now exposes an *explicit research-only*
thumb bind calibration percentage: **0% (original)**, 25%, 50%, 75%, 100%.
Changing it rebuilds both Testing shell weight fields while retaining the
original realistic POSITION/UV/NORMAL assets and WebXR skeleton and motion.
Setting **0%** takes the original weight transfer code path; none of the
experimental candidates are enabled by default. Other hand models are not
affected. The setting persists after reload; returning it to 0% provides an
immediate known baseline. Material isolation modes remain independent.

**Important:** The 100% thumb candidate previously showed expanded native
thumb triangles (right 5 → 23) and increased whole-hand edge stretching, so
it is **not** a validated correction. Intermediate settings are also only
unreviewed visual experiments. Do not publish an app with a nonzero value as
the approved/standard model, claim anatomical quality, or export the
candidate as a fixed source GLB based on this UI. Run real piano passages
and compare thumb/index webbing in both hands at identical positions.

## Fixed live thumb-only A/B (26 October 2026)

The first live 25–100% implementation unintentionally used **whole-hand**
anatomical-to-WebXR bone-frame queries. Thus it changed other fingers while
being labeled a thumb experiment. Prior deformation sweep results do **not**
validate this revised runtime option. The live Testing path now supplies
`thumbOnly: true`, restricting mapped query positions to an original native
thumb-influence mask with a smooth 0.10–0.60 web transition; all remaining
vertices are queried at their exact original positions, preserving baseline
weights and source surface. The research helper retains its original whole-hand
mode for offline comparison. A real-GLB regression asserts identical weights
on every original non-thumb vertex for **both hands**, and the existing
0% → 25% → 0% round-trip contract remains required. This is still experimental;
no variant is yet approved as the anatomically correct solution.

## Testing score-key contact alignment (27 October 2026 preview)

A user close-up exposed an index finger intersecting the pressed key and a
thumb floating beside its assigned pressed key. Root cause: the Testing
model did not receive score-note contact targets, and its anatomical
fingerpad vertex samples had been discarded. Its WebXR motion alone does not
promise physical contact for a different anatomical surface.

A reversible, persisted **Align fingerpads to pressed keys (Testing only)**
checkbox is now enabled by default. It supplies Testing with actual score
pitch, rendered key's depressed surface height and X/Z face bounds, and uses
skinned anatomical fingerpad samples with the existing bounded, fixed-length
finger-chain IK employed by Anatomical. It handles lateral and vertical pad
misses independently of the thumb weight-calibration setting. If disabled,
Testing uses uncorrected WebXR bone motion; WebXR/Anatomical/Improved are not
modified. This alters Testing joint poses *only during assigned active-note
contacts* and must be tested on real piano passages; do not claim perfect
physical contact or unchanged WebXR bone motion while the option is enabled.
