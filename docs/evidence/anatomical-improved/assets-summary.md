# Anatomical improved hand asset build evidence

Source SHA-256: `2d516fee4cb0889d8a0c71e86d6f8d48cce789314bc9f857b159baf4ca1c7a77`; source mesh: 985,318 vertices / 1,914,904 triangles.
Wrist cut: source Y=-0.28 source-coordinate units; the forearm is negative Y, fingers are positive Y. The clipped source has one contour at the cut.
Uniform scale: 0.14457783; source wrist-to-middle-tip 1.229608 source units; fitted and target reference distance 0.177774 m. The fit is a single similarity transform, with no nonuniform deformation.
UV transform baked into TEXCOORD_0: scale `[16.0022221, 15.8064184]`, offset `[7.6999997e-05, 0.0122619867]`; v is not flipped. Source TANGENT is preserved; the mirrored right hand flips tangent.w and triangle winding.

| Hand | LOD | Triangles | Vertices | Bytes | Wrist boundary loops | Nearest source vertex P95 (mm, fitted) | Silhouette symmetric P95 (mm, fitted) |
|---|---:|---:|---:|---:|---:|---:|---:|
| left | 0 | 34,999 | 18,475 | 958,384 | [55] | 0.175 | 0.466 |
| left | 1 | 17,999 | 9,526 | 498,416 | [39] | 0.184 | 0.466 |
| left | 2 | 8,000 | 4,254 | 227,532 | [26] | 0.189 | 0.466 |
| right | 0 | 34,999 | 18,475 | 958,356 | [55] | 0.175 | 0.466 |
| right | 1 | 17,999 | 9,526 | 498,388 | [39] | 0.184 | 0.466 |
| right | 2 | 8,000 | 4,254 | 227,504 | [26] | 0.189 | 0.466 |

Texture profile: `optimized`; high normal angular error versus its pre-quantization resized pixels: mean `0.950°`, P95 `1.271°`, max `1.531°` at 2048×2048 texels.

Lazy request payload by selected LOD (manifest + shared textures + one or both GLBs):

| LOD | Texture set | Shared textures (B) | One hand total (B) | Both hands total (B) |
|---:|---|---:|---:|---:|
| 0 | high | 2,405,264 | 3,428,096 | 4,386,452 |
| 1 | high | 2,405,264 | 2,968,128 | 3,466,516 |
| 2 | low | 393,103 | 685,083 | 912,587 |

Total output payload (including manifest.json): 6,231,395 bytes (5.94 MiB). Focused semantic checks: `{"bindMatricesReproduceRest": true, "lodTargetsInRange": true, "rightMirroringFlipsTangentHandedness": true, "sourceHashRecorded": true, "texturesExternalShared": true, "totalAssetBytesUnder6MiB": true, "uvTransformBaked": true, "uvsNormalized": true, "weightsFiniteNormalizedAndJointBounded": true}`.

Landmarks in the JSON evidence are estimated from source cross-sections and connected terminal caps, then transformed by the one global rest fit. MCP centers for the four fingers are centerline extrapolations into the palm; PIP/DIP centers use cross-section width minima when stable and a relative-position fallback otherwise. Metacarpal anchors are documented fractional wrist-to-MCP estimates because the source has no joint annotations or skeleton. Reference bone centers are used only for wrist placement, orientation, and scale; they do not drive per-finger landmarks or weights.

Limits: silhouette distances use filled projected triangles from a simplified 90,000-triangle source proxy and symmetric boundary-distance transforms at 384px; pixel scale is converted to final-rest meters using the global uniform fit. Nearest-source-vertex distances are a dense sampled-surface proximity estimate, not a continuous triangle Hausdorff bound. A reviewer should still inspect a rendered posed hand and animation behavior before accepting the runtime gate.

Reproduction: run `scratch/improved-assets/.venv/Scripts/python.exe -B tools/build_improved_hand_assets.py --output scratch/improved-assets/rebuild-output --evidence scratch/improved-assets/rebuild-evidence --scratch scratch/improved-assets/rebuild-work`. The default texture profile is `optimized`; pass `--texture-profile full` only to generate the full-quality comparison profile. The isolated build environment used Python 3.12, NumPy 2.5.4, SciPy 1.18.1, Pillow 13.0.0, and fast-simplification 0.2.0.

The optimized texture profile was approved after a same-camera, same-light paired render of both hands against the full-quality textures. That approval covers texture encoding and payload only. It does not accept posed runtime behavior; animation deformation remains under investigation. The six published GLBs are unchanged from the validated build, and the full asset test must pass against the published manifest and textures before runtime integration is accepted.
