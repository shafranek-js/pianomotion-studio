# Softer note-surface highlights — dev.20, 2026-10-18

Checkout `C:\Projects\pianomotion-studio`, layered over existing user changes. Only five parameters of the `grand-piano-highway-deck` material changed in production: roughness 0.16→0.76, metalness 0.06→0.02, clearcoat 0.9→0.06, clearcoatRoughness 0.12→0.78, envMapIntensity default 1→0.3. Dark color, opacity 0.88, geometry and shadow reception stay unchanged. Note, key and body materials, scene lighting, atmosphere, music and data storage are untouched. The shared renderer also applies this finish to fixed/manual video scenes.

GPT-6 Luna Extra High implemented the narrow material edit. Root independently reviewed the diff and actual before/after rendering, owns versions/docs/test harness and integration verification. No stage/commit/push/deploy.

## Visual and browser evidence

The harness clones the old material parameters for a controlled before/after comparison, holding production geometry, scene lights, four deterministic notes, time=0.4 s and camera constant. Backing/CSS viewport 1280×800, resolution=1. The supplied 1920×927 screenshot shows the reported Pianist POV issue; source and revised POV were opened together. The harness does not claim to reproduce the user's MIDI or hand pose.

- [Pianist POV before](chrome/deck-pov-before.png) / [after](chrome/deck-pov-after.png).
- [Concert before](chrome/deck-concert-before.png) / [after](chrome/deck-concert-after.png).
- Chrome: **1 scenario / 2 cameras PASS**, 18.4 s. [Report](chrome/report.json).
- Edge: **1 scenario / 2 cameras PASS**, 50.3 s. [Report](edge/report.json).
- No page/console errors. Both browsers keep all 88 keys.

Chrome changed-surface luminance (0–255 weighted RGB):

| Camera | Candidate deck probes | Changed surface probes | p99 before → after | Probes ≥120 before → after |
| --- | ---: | ---: | ---: | ---: |
| Pianist POV | 3321 | 3147 | 181.44 → 35.45 | 179 → 0 |
| Concert | 4573 | 4431 | 163.28 → 30.23 | 112 → 0 |

The regression requires reproducing the bright original (p99>80), at least 200 changed surface probes and after p99<70% of before. The first measurement erroneously included bright, unchanged instanced-note pixels despite its deck raycast. [Initial report/images](initial-measurement/report.json) are retained. Corrected sampling excludes identical pixels between frames; only the deck finish changes. The material was not retuned and the suppression criterion was not weakened to fix the sampler. Visual review agrees with the corrected measurement: broad dark lighting remains, sharp white/blue hotspots no longer compete with the notes.

## Checks and boundaries

- `npm run typecheck`: PASS.
- Scoped ESLint for fallingNotes3dView: PASS.
- `tsc -p tests/browser/r3d/tsconfig.json --noEmit`: PASS.
- `git diff --check`: PASS; Windows line-ending notices only.
- Focused render3d unit: **26/26 PASS, 6 files**. [Report](unit.json). No new unit test merely repeats material constants; the new browser regression checks the visible original defect.
- `npm run build`: PASS, buildId `7d660a051c2521f770604151`, 258 offline resources / 70.62 MiB. Existing large-JS-chunk warning remains. Concurrent library/menu/hand work is included in the build but not accepted by this material check.

The isolated browser config used port 4184 and dedicated `deck-<channel>` outputs; it does not interrupt the user's 5173 server or parallel verification. Reproduce with the normal free 4173 server using `PIANOMOTION_BROWSER_CHANNEL=chrome` / `msedge` and:

```powershell
node node_modules/@playwright/test/cli.js test --config playwright.config.ts tests/browser/stage-environment.spec.ts --grep 'note surface'
```

This is focused material/readability acceptance, not a full media, audio, PWA, musical-golden or stress rerun. Existing general light brightness still works; a new surface preference was not introduced. Version manifests/lockfile and release descriptions are synchronized to 0.1.0-dev.20. Rollback only these material parameters if needed; preserve geometry, atmosphere, data and unrelated user edits.
