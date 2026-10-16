# PianoMotion Studio — recovery and rollback

Current local implementation: 2026-10-16, dev.6. Built-in MIDI sources are read-only inputs in `builtin_melodies/midi`; rebuild their generated catalog with `npm run prepare:melodies`. Opening a melody creates a separate project: repairing/rebuilding the library must never delete project data. See `evidence/builtin-melodies-2026-10-16/VERIFICATION.md`, SOUNDFONT_STEREO_IMPLEMENTATION.md and AUDIT_REPAIR_PROGRESS.md for acceptance; historical milestone reports are not current release evidence.

## Protect data first

Keep the existing tab open after any save, import, Worker, bank or update error. A project is saved only after its IndexedDB transaction commits and the exact recovery snapshot is flushed. Update activation additionally checks that project/revision/change token have not changed during the operation. A blocked or failed result must not reload the tab.

If calculation fails, retain the editable draft and use Retry calculation in Diagnostics. If bank preparation fails, the previous prepared audio output remains active. A malformed import must not replace the current session. Where possible export a verified project package before maintenance; keep original MIDI/audio/SF2 files separately.

Do not clear site data, delete IndexedDB, delete stores, unregister all service workers or remove unrelated origin caches as routine repair. Browser profiles and origins have separate databases; moving between localhost ports does not migrate them.

## Production release rollback

The output is apps/client/dist, generated with npm run build. Each build has a content-derived ID, a matching sw.js, offline-manifest.json, and immutable releases/<buildId>/ assets. App base path and release resource base are separate. For a subdirectory set APP_BASE=/pianomotion/ before building and unset it afterwards for root builds.

Rollback is a deployment operation and needs separate authorization. Preserve the complete previous deployment, including its immutable release directory. Restore a coherent index, manifest and service worker together; do not hand-edit hashes, copy only new Python files over an older shell, or purge release assets used by open tabs. Mutable entry points should revalidate; release assets can be immutable.

The service worker stages and SHA-256 verifies every mandatory file, then publishes a completion marker as its last cache write. A failed final copy removes that incomplete cache; the last committed release remains usable. Cache retention uses installation metadata and open-client build pins, retaining current and previous committed releases and pinned releases. Only the application's base-scoped namespace is eligible for collection. Unrecognized older caches are left alone rather than risking unrelated data.

An update is offered through the status bar, including an update already waiting when the tab opened. The save barrier runs before activation. If it reports quota, abort, pending replan or intervening changes, fix that condition and retry; a failed save is not permission to refresh.

## Inspect storage without modifying it

The project database is handthesia_db, schema version 2, with projects, profiles, settings and session stores. SF2 source bytes live in the separate asset database implemented by audio/soundfont/soundfontAssetStore.ts; musical packages do not embed them automatically. Layout preferences live separately from musical documents.

Dev.5 upgrades `handthesia_soundfonts` to schema version 2, retaining legacy records until their atomic Blob/metadata migration commits. Musical project storage is separate and unchanged. An older application that requests SF2 database version 1 cannot open version 2; use the built-in synthesizer while investigating a source rollback, or restore a compatible dev.5 build. Do not delete or downgrade the asset database to make old code open it. Keep the original SF2 file independently.

The development build unregisters only its own exact-scope Service Worker and does not remove caches or databases. Reload a local tab once after replacing development modules to discard stale synth instances; this is distinct from clearing site data. Production uses its versioned offline release as before.

Record origin, build ID, engine hash, project ID/revision, error text and whether a transaction committed. Use read-only DevTools inspection or copy records for diagnosis. Do not overwrite a damaged record automatically: retain the original for developer-assisted recovery. A request-success event alone is not evidence of commit.

## Source rollback in this checkout

Working directory: C:\Projects\pianomotion-studio. Preserve dirty/untracked user work. No commit, reset, clean, push or publication is part of remediation. If a later authorized rollback uses Git, review and preserve current changes first; use an explicit scoped revert or a separate checkout instead of destructive reset/clean.
