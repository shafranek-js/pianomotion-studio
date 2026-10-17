# 3D browser acceptance

Run the dev server from the repository root, then open:

`http://127.0.0.1:5173/@fs/C:/Projects/pianomotion-studio/tests/browser/r3d/acceptance.html`

For another checkout, replace the absolute path after `/@fs/`. Press **Run MP4 + WebM checks**. The harness runs real Native analysis/export Workers and WebGL/WebCodecs; it checks all four fixed camera presets, finalized MP4/WebM, demux/decode, moving skin pixels, audio RMS, native playback and seek. No user project, SoundFont or IndexedDB data is replaced. The generated MIDI exists only in memory.

Typecheck:

```powershell
node node_modules/typescript/bin/tsc -p tests/browser/r3d/tsconfig.json
```

The harness requires Vite's development source routes and working encoders. A failure is reported in the page; an unavailable codec is not treated as a pass. The standard production media suite remains `npm run test:media` after a build and now explicitly selects 3D.

Results for dev.12: [verification](../../../docs/evidence/3d-repair-2026-10-17/VERIFICATION.md).
