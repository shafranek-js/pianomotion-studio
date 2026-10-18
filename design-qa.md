# Active-note glow visual QA — 0.1.0-dev.21, 2026-10-18

Scope: a soft hand-colored aura on playing 3D blocks. Reviewed actual production renderer screenshots at fixed 1280×800/resolution=1: [POV off](docs/evidence/active-note-glow-2026-10-18/chrome/active-notes-glow-off.png), [POV on](docs/evidence/active-note-glow-2026-10-18/chrome/active-notes-glow-pov.png), [Concert](docs/evidence/active-note-glow-2026-10-18/chrome/active-notes-glow-concert.png), [adjacent chord](docs/evidence/active-note-glow-2026-10-18/chrome/active-notes-glow-chord.png) and [rim edge](docs/evidence/active-note-glow-2026-10-18/chrome/active-notes-glow-edge.png). The isolated scene deliberately omits the user shell/hands; it uses the real shared renderer and deterministic note fixtures.

The first halo was too thin to read as glow; returned for wider spread before acceptance. The revised effect forms a quiet blue/green fringe around active blocks without washing out their shape or bringing back sharp deck highlights. Chord blocks remain individually readable. The high-note halo stays inside the rim; reflected color on the floor is part of the existing reflection pass. No new controls, copy, typography or layout were introduced. Hand/note colors and gold branding stay consistent.

Chrome and Edge each pass active/inactive/released/backward-seek checks and the earlier two-angle satin-deck regression. Fixed render returns the exact same pixels after backward seek. All 88 keys remain. [Metrics and exact verification limits](docs/evidence/active-note-glow-2026-10-18/VERIFICATION.md). No actionable visual P0/P1/P2 remains in the glow scope. Full release readiness and concurrent practice changes are not accepted here.

final result: passed (scoped visual acceptance)

---

# Historical note surface visual QA — 0.1.0-dev.20, 2026-10-18

Source: C:\Users\pavel\AppData\Local\Temp\codex-clipboard-6d5348b7-e143-4bdf-96d1-24e715bd9610.png (1920×927). Scope: soften distracting white/blue hotspots on the note deck.

Matched implementation: [POV before](docs/evidence/note-surface-2026-10-18/chrome/deck-pov-before.png) / [after](docs/evidence/note-surface-2026-10-18/chrome/deck-pov-after.png), plus [Concert before](docs/evidence/note-surface-2026-10-18/chrome/deck-concert-before.png) / [after](docs/evidence/note-surface-2026-10-18/chrome/deck-concert-after.png). Actual production Three.js renderer, fixed 1280×800 backing/CSS, resolution=1, time=0.4 s, four deterministic notes. Before/after use identical cameras and lighting. The user's screenshot and revised POV were opened in the same comparison input. The user's musical content, hands and UI are intentionally not cloned; source dimensions/crop differ from the isolated renderer.

Finding: P2 resolved. Low material roughness and a strong smooth clearcoat produced two bright distracting hotspots. The revised satin deck retains dark depth and broad soft illumination while removing the bright centers; notes regain visual priority. Body, keys, notes, lights and geometry were not modified.

Required surfaces: typography, copy, spacing/layout and UI tokens are unchanged (no new controls). Color/image quality: compare note readability and both highlight regions at full size, plus Concert for a second angle. Note/keyboard/branding colors remain consistent; the deck is intentionally quieter. No remaining actionable P0/P1/P2 in scope. Any wider hand, UI or material art pass is outside this change.

[Metrics, checks and limitations](docs/evidence/note-surface-2026-10-18/VERIFICATION.md). Chrome and Edge scenarios pass. This accepts the scoped material fix, not the entire release.

final result: passed

---
# Concert atmosphere visual QA — 0.1.0-dev.19, 2026-10-18

Current iteration: **passed** for the scoped lighting adaptation. Source remains the poster reference below. Implementation: [revised room](docs/evidence/stage-atmosphere-2026-10-18/iteration-2/atmosphere-room.png), [whole platform](docs/evidence/stage-atmosphere-2026-10-18/iteration-2/atmosphere-whole-platform.png) and [room with reflections](docs/evidence/stage-atmosphere-2026-10-18/chrome/stage-room-concert.png), 1280×800 fixed/manual production scene, resolution=1, time=0.4 s. The reference poster (543×498), revised room and whole platform were opened together in one comparison input. Cameras match across iterations; the poster is an art-direction source with intentionally different crop/aspect/state.

Comparison history: [first room capture](docs/evidence/stage-atmosphere-2026-10-18/iteration-1/atmosphere-room.png) had a P1: three sharply bounded nested cone silhouettes looked flat despite passing pixel checks. Returned to implementer; corrected with continuous profile falloff, lower density, mild taper and softer cyan-blue. Post-fix captures show a smoothly fading column without layered boundaries. Broad perimeter glow blends through the circular floor's outer fade. No actionable P0/P1/P2 remains in this scope.

Required surfaces for dev.19: typography, copy, spacing and UI tokens are unchanged from the accepted existing Inspector; no new controls or poster text/assets were introduced. Colors add restrained cyan-blue haze and wider blue floor illumination while preserving hand/note colors and gold branding. Render quality is judged in the full room, whole-circle edge and default Concert camera; physically rendered piano geometry remains visible through depth-tested transparent light. The full-circle capture provides a focused edge/fade check in addition to the room composition. The UI and mobile controls retain the prior verified layout.

P3 follow-up remains optional: more varied wood roughness/grain and higher-end physical volumetric shadowing. This implementation is an artistic scattering approximation, not a photographic clone or physically complete participating medium. [Functional evidence and limitations](docs/evidence/stage-atmosphere-2026-10-18/VERIFICATION.md).

Historical dev.19 result: passed

---

## Historical accepted stage baseline — dev.18

Source visual truth: `C:\Users\pavel\AppData\Local\Temp\codex-clipboard-1648fafd-05a6-4106-b367-f734d67bdf92.png` (543×498). The poster is an art-direction reference for blue stage light, warm highlights and a reflective dark floor. The approved scope adapts the existing interactive piano; it does not reproduce poster text, furniture, an opened lid or its photographic camera.

Implementation: [room](docs/evidence/concert-stage-2026-10-18/chrome/stage-room-concert.png), [whole circular platform](docs/evidence/concert-stage-2026-10-18/chrome/stage-wide-overview.png), [live controls](docs/evidence/concert-stage-2026-10-18/chrome/stage-settings-live-ui.png), [mobile sheet](docs/evidence/concert-stage-2026-10-18/chrome/stage-settings-mobile.png). Reference and room/mobile captures were opened together in one comparison input. Additional close floor/reflection and live Inspector screenshots were opened separately to inspect detail.

Viewport/state: deterministic production Three.js scene at 1280×800 backing/CSS pixels, resolution=1, manual time 0.4 s; room evidence camera shows the entire instrument. Live application at 1440×900, mobile at 390×844; deviceScaleFactor=1. Poster and application have different subjects, aspect ratios and camera states by design. No claim of pixel-for-pixel fidelity or photographic realism is made. The wider overview is used to judge the fading perimeter rather than the poster composition.

## Findings and comparison history

- P2 corrected: reflection default 0.28 was not representable by the range's 0.05 step; native input rounded it to 0.30 while the displayed percentage stayed 28%. Step changed to 0.01. Final Chrome preferences and Edge runs explicitly assert value 0.28 and accessible text 28%, then exercise the full range.
- No remaining actionable P0/P1/P2 in the scoped stage/controls comparison. The round platform blends into the background, reflections follow actual rendered geometry, warm/cool highlights preserve note colors, and all four environment controls remain reachable in the mobile sheet.

## Required visual surfaces

- Typography: existing studio system fonts, compact hierarchy and percentages retained; no poster advertising text copied. New labels/hints use six existing locale dictionaries. Both range controls have accessible labels and percentage values.
- Spacing/layout: controls follow the existing Inspector card rhythm; desktop overlay and mobile scrolling sheet remain within the viewport. Stage geometry is independent of the panel; controls do not replace the main scene.
- Color/tokens: Concert uses graphite/blue surroundings and warm key light; Studio removes the blue pool and uses neutral fill. Existing semantic left/right note colors remain distinct. Gold piano branding remains visible.
- Image/render quality: actual Three.js piano, local floor texture, geometry, shadow map and planar reflection are used. No raster screenshot substitutes the live scene. The floor and reflection fade at the same radial boundary. Fixed/manual scenes preserve 88 keys and 1280×800 output dimensions across quality changes.
- Copy: clear preset, brightness, floor reflection, quality and local-storage explanation; no implementation notes added to primary playback controls. The previous shared project hint describes other scene settings; the environment card explicitly distinguishes local preferences.

## Functional evidence and limits

Real WebGL checks cover static-vs-moving reflections, brightness/presets, target sizes, disabling reflection and absence of page/console errors in the harness. Real application checks cover playback, stable revision/project/Worker, committed settings, reload and mobile controls. See [verification](docs/evidence/concert-stage-2026-10-18/VERIFICATION.md) for exact commands/results and untested media/PWA/performance gates.

P3 follow-up: low-resolution reflections intentionally trade detail for GPU cost; higher quality can improve thin reflected highlights. A broader material/art pass could add less regular wood grain and more nuanced roughness, but those changes are outside this accepted stage iteration.

Implementation checklist: circular fade, real soft reflection, two light presets, working/persisted controls, mobile access, fixed/manual regression, release version and handoff completed.

Historical dev.18 result: passed
