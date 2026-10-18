# Soft active-note glow — dev.21, 2026-10-18

Checkout: `C:\Projects\pianomotion-studio`, on top of the existing dirty tree. Scope: a restrained hand-colored halo under actively playing 3D note blocks. No audio, transport, MIDI, project format, lighting or satin-deck changes in this task. No stage/commit/push/deploy.

## Implementation and review

GPT-6 Luna Extra High implemented `activeNoteGlow3d.ts`, its integration in `fallingNotes3dView.ts` and focused tests. Root owns version metadata, browser harness, integration review and documentation. One preallocated InstancedMesh, maximum 2048 instances, uses a soft additive shader without fullscreen bloom or extra render targets. It does not cast shadows, write depth or intercept pointer events; the existing group owner disposes its GPU resources.

Each halo follows the rendered PerformancePlan press/release interval, or the existing source-note interval when no plan exists. A valid empty plan stays empty. Smoothstep attack is 45 ms and release is 75 ms within that interval. Musical time alone reconstructs the result, including backward seek and fixed/manual rendering. The expanded lane is clipped to the same curved piano footprint, with 0.18 in lateral spread, 0.24 in trailing spread, strength 0.45. Fronts stay at the strike line instead of spilling onto keys.

Root returned two implementation errors before browser acceptance: the XZ plane initially scaled depth on Y, and its ShaderMaterial redeclared Three's built-in instanceColor attribute. The implementer fixed both and added a world-bounds regression. Initial actual screenshots then showed a hairline rather than a soft readable glow; root returned it for wider spread. The final screenshots below use the revised values. No pixel thresholds were reduced.

## Real browser evidence

Tests instantiate the production `PianoScene3D` with fixed 1280×800 backing/CSS viewport, resolution=1 and manual musical time; the harness does not replace the renderer with a mock. It intentionally omits the app shell and moving hands to isolate the effect.

- Chrome: **2/2 PASS**, 80.1 s including server lifecycle. [Report](chrome/report.json).
- Edge: **2/2 PASS**, 109.5 s including server lifecycle. [Report](edge/report.json).
- Each browser checks active/future/released notes, backward seek, six adjacent chord notes, highest-pitch long note near the rim, 88 keys, no page/console errors and the previous satin-highlight regression in POV and Concert.
- [Glow off](chrome/active-notes-glow-off.png) / [Pianist POV on](chrome/active-notes-glow-pov.png), [Concert](chrome/active-notes-glow-concert.png), [adjacent chord](chrome/active-notes-glow-chord.png), [edge note](chrome/active-notes-glow-edge.png).

Both browsers give identical on/off sampling: 348 changed samples out of 64000 at time 0.7 s. Future notes at time 0 and released notes at time 3 give zero pixel difference with the halo disabled. Seeking back to 0.7 s reconstructs the exact earlier frame (zero difference). The changed-sample visibility requirement is >50. Counts/IDs are checked separately; six chord notes and the edge note are captured for independent visual inspection.

Satin material regression remains green: POV p99 changed-deck luminance 181.44→35.45; Concert 163.28→30.31, below the original 70% ceiling. The gentle aura remains distinct from the earlier distracting white/blue surface hotspots.

## Other checks and limits

- Focused render3d unit: **29/29 PASS, 7 files**. [Report](unit.json). Includes shifted plan timings, valid empty plan, reverse seek, envelope boundaries, curved rear clipping and flat world-Z bounds.
- Scoped ESLint of the helper, integration and tests: PASS.
- Browser-harness TypeScript: PASS (`tsc -p tests/browser/r3d/tsconfig.json --noEmit`).
- Full `npm run typecheck`: **PASS on the final repeat**. An earlier run encountered newly changing `audio/transportLoop.test.ts`: union narrowing, readonly currentTime and a StretchScheduleOptions property. Concurrent A–B/practice work subsequently resolved those diagnostics; no audio/practice files were changed by the glow task to silence them.
- `git diff --check`: PASS, existing Windows line-ending warnings only.
- `npm run build`: PASS, buildId `b645db3fbd712200d86f9b12`, 258 offline resources / 70.65 MiB. Existing >500 kB JS chunk warning remains. Engine `60341216864eb0a548fbc66ba2b1848b9bb7b6b2de85c2c1e7f03fbd655bc63a`, Pyodide 314.0.7. This build also contains unrelated user work, which is not accepted by the glow tests.
- User's `http://127.0.0.1:5173/` and the tuned helper module both return HTTP 200. Isolated browser checks used port 4185 and did not stop the user's server.

Versions in workspace manifests/lockfile and release descriptions are synchronized to 0.1.0-dev.21. Reproduce browser checks on a free normal dev test port with `PIANOMOTION_BROWSER_CHANNEL=chrome` or `msedge`:

```powershell
node node_modules/@playwright/test/cli.js test --config playwright.config.ts tests/browser/stage-environment.spec.ts --grep 'glow|note surface'
```

This is scoped 3D visual/timing acceptance, not a full suite, weak-device stress test, audio/PWA regression or decoded MP4/WebM acceptance. The shared fixed renderer reconstructs the effect deterministically; new media files were not encoded in this task. No changes to 2D fingering rendering. Rollback only the glow helper/integration and corresponding version metadata; preserve the satin deck, curved geometry, project data and all unrelated edits. Site-data deletion is unnecessary.
