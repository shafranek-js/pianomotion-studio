# Professional studio workspace — implementation record

Date: 2026-10-14. Starting commit: `dc7eb963ff793110c586b4e86129cb22282cd452`.
Authoritative scope: the user's approved PianoMotion Studio workspace plan in this chat.

## Outcome required

Performance-first, full-width graphite studio; persistent player/editor lifetime;
File menu and real MIDI/project/package opening; overlay/pinnable panels;
responsive Performance/Fingering modes on one shared scene; committed save states.
No commit, push or deployment is authorized by this implementation request.

## User amendments during implementation

- The separate piano roll and Split layout are superseded by one persistent
  notes/keyboard/hands scene. Performance uses performed timing; Fingering uses
  source timing and adds hit testing, selection, scrolling and assignment tools.
- Only the controls relevant to the selected mode are visible. Existing editor
  history is retained; a mode switch is a presentation change, not a new session.
- As of dev.3 (2026-10-15), the hand/finger/Clear/Unplayable/Gliss assignment
  group belongs in the application header after the mode switch, visible only
  in Fingering. Narrow windows wrap it into additional header rows.
- In dev.4, the remaining contextual row is removed: Undo/Redo live in Edit,
  Keyboard shortcuts in Help (?), and Auto-advance beside finger assignments.
  The editor stays mounted headlessly and retains its state. Auto-advance is
  off by default and advances only after a numeric finger assignment; confirming
  the same finger can advance without a new history entry or musical replan.
- Diagnostics, application version and change descriptions live in a compact
  bottom status bar, with details available on demand. Long logs stay collapsed.
- Legacy saved `split` mode is accepted and normalized to Performance; obsolete
  layout fields can be read for compatibility but expose no third mode.

## Ownership

| Agent | Scope |
|---|---|
| studio_shell (GPT-6 Luna Extra High) | StudioShell/types/layout preferences, shared CSS, sole dependency/lockfile writer |
| studio_workspace (GPT-6 Luna Extra High) | Workspace/transport, editor presentation and keyboard scope, renderer sizing, document title |
| studio_session (GPT-6 Luna Extra High) | App/player session controller, projects/inspector, storage/contracts/package v2, narrow core/persistence blockers |
| Orchestrator | API coordination, review/repair requests, independent browser/visual tests, evidence and handoff |

Shared files have one writer. Existing desktop checkout is not the implementation target.
Canonical MIDI/golden fixtures and numerical algorithms remain protected.

## Acceptance

- Viewports: 1920x1080, 1440x900, 1366x768, 1024x768, 768x1024, 390x844.
- No horizontal page overflow; closed panels leave a full-width keyboard with 88 keys.
- Scene/transport visible immediately on an opened project; narrow layouts retain usable controls.
- Overlay/pin/Focus/mode transitions preserve transport, worker identity and editor history/selection.
- Painted note hit testing and selection use the renderer's exact geometry.
- Editor time scrolling/zoom preserves transport position; keyboard/hands agree with preview time.
- Escape/focus return, form-safe shortcuts and 44px mobile targets.
- Edit/save/export → fresh context → package open retains original bytes, IDs, profile and manual intent.
- Invalid package/missing bytes/commit abort leave the current project/data intact.
- Actual Worker replan, persistence commit, legacy v1 migration and changed-engine recompute verified.
- Unsupported outputs and broken video export are unavailable with a clear explanation.

## Independent verification completed

All results below are for the current working tree, not a published release.

| Check | Result |
|---|---|
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd run test:unit` | 314/314 tests, 21 files, PASS |
| Studio/files/profiles/stabilization/video availability browser batch | 10/10, PASS, 5.7 min |
| Bootstrap/editor/player/skins and numerical parity browser batch | 19/19, PASS, 6.2 min |
| Imported custom profile and saved-project list opening | 1/1, PASS, 1.8 min |
| Profiles journey rerun after imported-profile repair | 1/1, PASS (overlaps the first batch) |
| CPython direct replan and export runners | 4/4 + 4/4, PASS |
| `npm.cmd run build` + final direct Vite build after icon cleanup | PASS; assets hash checks PASS |
| `git diff --check` | PASS; canonical fixture/golden files unchanged |

These batches cover **30 distinct browser tests**. The four PWA deployment tests
were not included; this is not a full browser-suite or release acceptance claim.
The 13 numerical fixture scenarios include malformed and repaired inputs and
report zero differences against the unchanged goldens in real Pyodide Workers.
Reported Worker count refers only to the Python analysis Worker: Pixi texture
decoder Workers are separate. Mode, panel, pin, Focus and resize operations retain
the same scene and analysis Worker.

Layout checks and PNG captures cover empty, Performance and Fingering at all six
specified sizes. Visual review covers representative empty/Performance states,
Fingering at all six sizes, Projects pinned, Inspector, Preferences and the
imported Pianist workspace. Live
loading/error checks retain the active scene and show their status at the bottom.
No Split view is expected after the user's amendment. Desktop browser checks do
not establish real mobile-device performance or accessibility certification.

Evidence root on this machine:
`C:\Users\pavel\.codex\visualizations\2026\10\13\01a134bd-3548-7483-bf3b-27bf94b721c4`.

- `studio-final-review/`: accepted 10-test batch and six-size PNGs.
- `studio-core-regression/`: accepted 19-test core/UI batch.
- `studio-profile-final/`: imported profile revision/anatomy, duplicate, commit
  and actual reopening through File → Open saved project.
- `studio-profile-review/`: profile journey rerun; its first new-test attempt
  used an invalid test package and was superseded by `studio-profile-final`.

The final production main chunk after the rendering follow-up is 946.52 kB
(274.60 kB gzip); Vite warns about
chunks over 500 kB. Runtime/wheel assets total 21.37 MiB. Code splitting and
weak-device cold-start performance are future work, not measured release gates.

## Integration repairs and continuation boundaries

- `replan_document` now obtains its engine version; dense motion sampling retains
  canonical diagnostic timestamps so the numerical golden checks remain exact.
- IndexedDB promises resolve on transaction commit, including layout/settings
  writes. A real abort after request success cannot announce a saved project.
- Candidate preparation passes its live Worker to the player. StrictMode cleanup
  defers termination to distinguish effect replay from a real session disposal.
  Worker operations serialize access to the Python interpreter and source context.
- The unified editor is mounted across mode changes; selection uses painted
  geometry, history survives and form inputs retain their native shortcuts.
- v2 portable packages store source namespace and geometry. v1 geometry requires
  explicit choice; bytes, IDs and manual intent must validate before switching.
- Imported custom profiles can be saved with a new revision and duplicated from
  their actual session data. Canonical presets require a copy before editing.
- Pending autosaves retain draft intent and current profile without combining
  stale derived plans. Errors stay available through footer/Inspector; startup
  failures do not place long diagnostics in the central workspace.

Working directory: `C:\Projects\pianomotion-studio`. Dev URL:
`http://127.0.0.1:5176/`. Version remains `0.0.0` / Development build. Changes are
uncommitted above the starting commit; no push, deployment or release was made.
The separate desktop checkout and the old server on 5173 were not changed.

The prior audit's unrelated audio/video/PWA/resource findings remain separately
scoped: offline bootstrap, video/audio mux and duration, SoundFont/Web MIDI,
offline WAV performance timing, audio gain/speed transitions, animation cache and
motion-buffer edge cases. Unsupported outputs are unavailable in this UI; a
disabled menu is not acceptance of the underlying encoder. Fix and verify each
subsystem's original defect before claiming release readiness.

## Anti-aliasing follow-up — 2026-10-14

User requested smoothing of jagged hand contours. `PianoScene.create` enables
PixiJS `antialias:true` for the entire canvas. Rendering uses native DPR clamped
to 1–2 (fallback 1 for invalid/unavailable DPR); resize updates backing density
without changing logical coordinates or musical plans.

A first draft used fixed 2× supersampling plus MSAA. Its six-size screenshot batch
reached the final Inspector screenshot but exceeded 180 seconds; that draft was
replaced by native density plus antialiasing. The final six-size test passed in
1.2 min, checking actual WebGL context antialias flags, framebuffer dimensions,
88 keys, mode/panel/Focus transitions, and form-safe keyboard handling. The
screenshot-heavy test has a 300-second bound for software GPU runs; no functional
assertions were removed. This is not a measured FPS or weak-device acceptance.

Typecheck, lint and the final Vite build pass. Numerical unit suites were not
repeated for this renderer-only change. Evidence: `antialias-native-final/` (21
PNG captures), and `antialias-review/before.png` / `after-native.png` (live local
studio). Existing studio changes, source fixtures and project files are retained.
