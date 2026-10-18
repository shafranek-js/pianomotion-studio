# Browser verification

Run browser groups sequentially. `npm run test:browser:all` runs UI, Worker,
audio, large SoundFont, production PWA and media groups in that order. Select
Windows Chrome or Edge with `PIANOMOTION_BROWSER_CHANNEL=chrome` / `msedge`.
Each configuration writes its own JSON report under `test-results/reports/`.

## Studio setup

- A fresh `/` opens the default anthem. Use `/?empty=true` when explicitly
  opening another MIDI/package. This query suppresses the default song, not
  recovery of an existing session. Recovery tests must retain their storage.
- Both renderers remain mounted after 3D initialization. `studioCanvas(page)`
  selects the visible canvas; `expectStudioCanvas` requires exactly one visible
  canvas. Use `studioCanvas(page, "2d")` for note geometry, editor input and 2D
  identity, or `studioCanvas(page, "3d")` for Three.js identity. Do not resolve
  ambiguity with `.first()` or assert that only one canvas exists.
- Ordinary UI scenarios explicitly use
  `loadStudioSong(page, { output: "synth", dimension: "2d" })`. These options
  operate the actual Preferences/Performance controls. They avoid making every
  editor/storage test depend on SF3 preparation and continuous 3D rendering on
  software-rendered CI machines. No audio, renderer or Worker success is mocked.
- Omit those options in audio/default-bank acceptance. The dedicated dimension
  transition test uses the actual default 3D view and retains both canvases while
  exercising playback, editing and Undo/Redo. `soundfont-sf3.spec.ts` verifies the
  default included bank, live playback and audible WAV/MP4/WebM.
- Native is the default calculation engine. A test claiming Python/Pyodide
  coverage must select Python and verify the actual Worker URL. Keep the 13
  numerical goldens and their tolerances unchanged. Those goldens explicitly
  activate the `default` pianist; the app currently starts with `virtuoso`.
  Pin the reference profile and realistic keyboard before comparing coordinates.
- For production tests, read committed settings through
  `committedStudioSettings`. Development `/src/...` imports are unavailable in a
  production build. Request success alone does not prove an IndexedDB commit.
- Wheel dispatch is asynchronous. Before using painted note coordinates, wait
  for the new editor view time. A nonempty note list can describe the old frame.
- Storage/commit tests use the shared valid synthetic SF2 generators. A hand-made
  truncated RIFF file can fail parsing before reaching the transaction being
  tested; malformed banks belong in the parser's rejection cases.

Full CI success requires all groups in both selected browsers. A focused pass
or successful Pages deployment does not close that gate. Keep failures and
unexecuted groups explicit in evidence; do not hide them with skips or retries.

## 3D stage environment

`stage-environment.spec.ts` renders the production Three.js scene in a fixed
1280×800 viewport. Floor probes exclude foreground geometry by raycasting;
they compare presets, brightness, reflection on/off, stationary versus animated
frames, and the fading perimeter. A wide overview exposes the whole disk;
the additional room view is an evidence camera, not a new product preset.
The UI scenario uses real synth/Worker playback, checks project/revision and
Worker identity, committed preferences, reload, and a 390×844 inspector sheet.
It is focused stage acceptance, not complete media/PWA/GPU performance acceptance.
