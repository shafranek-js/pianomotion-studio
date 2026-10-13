# Hand-thesia Web — Rollback & Recovery Procedures

This runbook outlines operational procedures for rolling back web deployments, handling service worker cache invalidation, and recovering from data or runtime issues.

---

## 1. Hosting / CDN Deployment Rollback

Because Hand-thesia Web is distributed as an immutable static client bundle (`web/apps/client/dist`), rollbacks on modern static hosts (Cloudflare Pages, Netlify, Vercel, S3/CloudFront) are instant and zero-downtime:

1. **Host Dashboard**:
   - Navigate to the deployment history in the hosting provider dashboard.
   - Select the previous stable deployment hash/ID.
   - Click **Promote to Production** / **Rollback**.
2. **CDN Cache Purge**:
   - Purge `/index.html`, `/sw.js`, and `/manifest.webmanifest`.
   - Hashed static assets in `/assets/` do not require purging because they are content-hashed and immutable.

---

## 2. Client-Side Service Worker Cache Invalidation

When an urgent hotfix or rollback occurs, client browsers that have cached the previous Service Worker must be forced to refresh:

1. **Increment Cache Version in `sw.js`**:
   - Change `CACHE_NAME = 'handthesia-shell-v1'` to `handthesia-shell-v2`.
   - On the next client visit, the browser detects byte changes in `/sw.js` (served with `no-cache, no-store, must-revalidate`).
2. **Automatic Lifecycle Handling**:
   - The service worker `activate` event automatically deletes all caches that do not match the current `CACHE_NAME` or `PYODIDE_CACHE`:
     ```js
     caches.keys().then((keys) =>
       Promise.all(
         keys.filter((k) => k !== CACHE_NAME && k !== PYODIDE_CACHE).map((k) => caches.delete(k)),
       ),
     );
     ```
   - `self.clients.claim()` ensures active tabs immediately transition to the updated worker.

---

## 3. Database & Storage Migration Recovery

### IndexedDB Schema Versioning:
- Current Database: `handthesia_db` at version `2`.
- Store layout:
  - `projects`: Primary project storage.
  - `profiles`: Custom PianistProfile DTOs.
  - `settings`: Client configuration.
  - `session`: Autosave recovery snapshots.

### Emergency Database Recovery:
If a client experiences corrupted local storage:
1. Open Developer Tools -> Application / Storage -> IndexedDB -> `handthesia_db`.
2. Inspect the `session` store for the last valid autosave snapshot (`AUTOSAVE_SESSION_ID`).
3. To reset settings without losing songs: delete the `handthesia:settings` key in `localStorage`.
4. If a hard reset is necessary: click **Clear site data**; users can re-import their saved `.handthesia.json` project packages.

---

## 4. Source Control Rollback Policy

In accordance with project best practices:
- All application files reside strictly within `web/`.
- Never execute destructive `git reset --hard` or `git clean` on shared environments.
- Use explicit revert commits (`git revert <commit-sha>`) if rollbacks are authorized by the user.
