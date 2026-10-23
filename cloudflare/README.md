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
