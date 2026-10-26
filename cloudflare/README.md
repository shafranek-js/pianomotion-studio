# Cloudflare Workers deployment

This project has a full offline-PWA release, including a pinned 39.9 MB SF3 SoundFont.
Cloudflare Workers Static Assets limits each individual file to 25 MiB.

Cloudflare dashboard → connect `shafranek-js/pianomotion-studio`:

- Build: `npm run build && npm run verify:release && node cloudflare/prepare-assets.mjs`
- Deploy: `npx wrangler deploy`
- Build root: repository root (default)
- Project: `pianomotion-studio`

The release build remains unchanged. Only the Cloudflare deployment artifact is
split after verification. `cloudflare/worker.mjs` reconstructs the original SF3
response, which retains the checksum recorded in `offline-manifest.json`. The
PWA, its service worker, and the GitHub Pages workflow continue to request the
original file path and need no changes.

If a different file over 25 MiB appears in a later release, packaging fails
clearly instead of accidentally shipping a broken offline release.

Note: This Worker streams the full SoundFont; it does not implement HTTP byte
ranges. The existing SoundFont browser loader requests the whole source file.

## Explicit production release approval (required)

The **GitHub `main` branch is also the local development branch**. Commits
may contain experimental Testing-hand UI/geometry that is not approved for
public release. The Cloudflare Workers Git-connected build must therefore
**not** auto-publish every push to `main`.

The existing Cloudflare Build command
(`npm run build && npm run verify:release && node cloudflare/prepare-assets.mjs`)
now fails closed in the final asset preparation step unless the build
has the environment variable **`PIANOMOTION_CLOUDFLARE_RELEASE_SHA`** set
to the **exact full 40-character SHA of the checked-out, approved commit**.
This keeps the previously deployed Worker intact when normal `main` pushes
happen. Build jobs may appear *failed/blocked* for development commits;
this is deliberate, not a production site outage. GitHub Pages already
requires explicit manual workflow dispatch and `PAGES_ENABLED=true`.

For an intentional Cloudflare public release, verify the chosen Git commit
(and its `npm run ci:local` evidence), temporarily set
`PIANOMOTION_CLOUDFLARE_RELEASE_SHA=<that commit's full SHA>` in the
Cloudflare build environment, then trigger a new deployment of **that exact
commit**. After release, retain the pinned SHA or clear the variable;
subsequent development commits will be blocked until individually approved.
Never set this to `main`, `latest`, a short SHA, or a wildcard. This gate
is applied to the documented Git-connected Build path; explicit manual
`wrangler deploy` from another environment is a separate intentional action.

For a quick local safety test, run
`node --test cloudflare/release-gate.test.mjs`.
