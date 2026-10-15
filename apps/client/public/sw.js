/// <reference lib="webworker" />
/* global self, caches */

/** Build-time replacement makes this worker script change with every release. */
const BUILD_ID = "__PIANOMOTION_BUILD_ID__";
const SCOPE_URL = new URL(self.registration.scope);
const BASE_PATH = SCOPE_URL.pathname.endsWith("/") ? SCOPE_URL.pathname : `${SCOPE_URL.pathname}/`;
const PATH_SLUG = BASE_PATH === "/"
  ? "root"
  : `scope-${btoa(BASE_PATH).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
const CACHE_PREFIX = `pianomotion-${PATH_SLUG}-`;
const STAGE_CACHE_PREFIX = `${CACHE_PREFIX}stage-`;
const BUILD_CACHE_PREFIX = `${CACHE_PREFIX}build-`;
const META_CACHE_NAME = `${CACHE_PREFIX}meta-v1`;
const MANIFEST_NAME = "offline-manifest.json";
const CLIENT_PINS_PATH = "__pwa-meta__/client-pins/";
const HEX_HASH = /^[a-f0-9]{64}$/i;
let maintenanceTail = Promise.resolve();

function resolveUrl(relativePath) {
  return new URL(relativePath, SCOPE_URL).href;
}

function buildCacheName(buildId) {
  return `${BUILD_CACHE_PREFIX}${buildId}`;
}

function commitUrl(buildId) {
  return resolveUrl(`__pwa-meta__/committed-${buildId}.json`);
}

function clientPinUrl(clientId) {
  return resolveUrl(`${CLIENT_PINS_PATH}${encodeURIComponent(clientId)}.json`);
}

function serializeMaintenance(operation) {
  const result = maintenanceTail.then(operation, operation);
  maintenanceTail = result.catch(() => undefined);
  return result;
}

function relativeAssetPath(path) {
  if (typeof path !== "string" || path.startsWith("/") || path.includes("\\")) {
    throw new Error("Offline manifest contains an invalid asset path.");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Offline manifest contains an unsafe asset path.");
  }
  return path;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 2 || manifest.buildId !== BUILD_ID || !Array.isArray(manifest.files)) {
    throw new Error("Offline manifest does not match this service worker build.");
  }

  const seen = new Set();
  let hasIndex = false;
  for (const file of manifest.files) {
    const path = relativeAssetPath(file?.path);
    if (seen.has(path) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 ||
        typeof file.sha256 !== "string" || !HEX_HASH.test(file.sha256)) {
      throw new Error(`Offline manifest contains an invalid or duplicate entry: ${path}`);
    }
    seen.add(path);
    if (path === "index.html") {
      hasIndex = true;
    } else if (!path.startsWith(`releases/${BUILD_ID}/`)) {
      throw new Error(`Offline asset is outside the immutable release directory: ${path}`);
    }
  }
  if (!hasIndex || seen.size < 2) {
    throw new Error("Offline manifest is missing the application shell or release assets.");
  }
  return seen;
}

async function readCommitRecord(cacheName, buildId) {
  if (!cacheName || !(await caches.has(cacheName))) {
    return null;
  }
  const cache = await caches.open(cacheName);
  const response = await cache.match(commitUrl(buildId));
  if (!response) {
    return null;
  }
  try {
    const record = await response.json();
    if (record?.schemaVersion !== 1 || record.buildId !== buildId || !Array.isArray(record.paths)) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

async function cacheIsComplete(cacheName, buildId, expectedPaths) {
  const record = await readCommitRecord(cacheName, buildId);
  if (!record || (expectedPaths && (record.paths.length !== expectedPaths.size || record.paths.some((path) => !expectedPaths.has(path))))) {
    return false;
  }
  const cache = await caches.open(cacheName);
  if (!(await cache.match(resolveUrl(""))) || !(await cache.match(resolveUrl(MANIFEST_NAME)))) {
    return false;
  }
  const paths = expectedPaths ?? new Set(record.paths);
  for (const path of paths) {
    if (!(await cache.match(resolveUrl(path)))) {
      return false;
    }
  }
  return true;
}

async function loadPins() {
  const metaCache = await caches.open(META_CACHE_NAME);
  const prefix = new URL(CLIENT_PINS_PATH, SCOPE_URL).pathname;
  const pins = [];
  for (const request of await metaCache.keys()) {
    if (!new URL(request.url).pathname.startsWith(prefix)) {
      continue;
    }
    try {
      const data = await (await metaCache.match(request))?.json();
      if (data?.schemaVersion === 1 && typeof data.clientId === "string" && typeof data.buildId === "string") {
        pins.push([data.clientId, data.buildId]);
      }
    } catch {
      // Ignore malformed pin records; activation will leave unrelated metadata alone.
    }
  }
  return pins;
}

async function savePin(clientId, buildId) {
  const metaCache = await caches.open(META_CACHE_NAME);
  await metaCache.put(clientPinUrl(clientId), new Response(JSON.stringify({ schemaVersion: 1, clientId, buildId }), {
    headers: { "Content-Type": "application/json" },
  }));
}

async function removePin(clientId) {
  const metaCache = await caches.open(META_CACHE_NAME);
  await metaCache.delete(clientPinUrl(clientId));
}

async function pinBuildForClient(clientId, buildId) {
  if (!clientId || typeof buildId !== "string" || !/^[a-f0-9]{16,64}$/i.test(buildId)) {
    return;
  }
  const record = await readCommitRecord(buildCacheName(buildId), buildId);
  if (!record) {
    return;
  }
  await savePin(clientId, buildId);
}

async function getPinnedBuild(clientId) {
  if (!clientId) {
    return null;
  }
  const metaCache = await caches.open(META_CACHE_NAME);
  const response = await metaCache.match(clientPinUrl(clientId));
  if (!response) {
    return null;
  }
  let buildId;
  try {
    const record = await response.json();
    if (record?.schemaVersion !== 1 || record.clientId !== clientId) return null;
    buildId = record.buildId;
  } catch {
    return null;
  }
  if (typeof buildId !== "string" || !/^[a-f0-9]{16,64}$/i.test(buildId)) return null;
  return (await readCommitRecord(buildCacheName(buildId), buildId)) ? buildId : null;
}

async function stageAndCommitBuild(manifest, expectedPaths) {
  const finalCacheName = buildCacheName(BUILD_ID);
  const stageCacheName = `${STAGE_CACHE_PREFIX}${BUILD_ID}`;
  const manifestUrl = resolveUrl(MANIFEST_NAME);

  if (await cacheIsComplete(finalCacheName, BUILD_ID, expectedPaths)) {
    return;
  }
  if (await caches.has(finalCacheName)) {
    await caches.delete(finalCacheName);
  }
  await caches.delete(stageCacheName);
  const stageCache = await caches.open(stageCacheName);

  try {
    await stageCache.put(manifestUrl, new Response(JSON.stringify(manifest), {
      headers: { "Content-Type": "application/json" },
    }));

    let indexResponse = null;
    for (const file of manifest.files) {
      const path = relativeAssetPath(file.path);
      const fileUrl = resolveUrl(path);
      const response = await fetch(fileUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to download ${path}: HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== file.sizeBytes) {
        throw new Error(`Size mismatch for ${path}: expected ${file.sizeBytes} bytes, got ${buffer.byteLength}`);
      }
      const actualHash = await sha256Hex(buffer);
      if (actualHash !== file.sha256.toLowerCase()) {
        throw new Error(`Checksum mismatch for ${path}: expected ${file.sha256}, got ${actualHash}`);
      }
      const stagedResponse = new Response(buffer, {
        status: 200,
        headers: response.headers,
      });
      await stageCache.put(fileUrl, stagedResponse.clone());
      if (path === "index.html") {
        indexResponse = stagedResponse;
      }
    }

    if (!indexResponse) {
      throw new Error("The offline manifest did not include index.html.");
    }
    await stageCache.put(resolveUrl(""), indexResponse.clone());

    const stagedRequests = await stageCache.keys();
    if (stagedRequests.length !== expectedPaths.size + 2) {
      throw new Error("The staged cache is incomplete.");
    }

    const finalCache = await caches.open(finalCacheName);
    try {
      for (const request of stagedRequests) {
        const response = await stageCache.match(request);
        if (!response) {
          throw new Error(`A staged response disappeared before promotion: ${request.url}`);
        }
        await finalCache.put(request, response);
      }

      // This commit marker is deliberately the final write into the release cache.
      await finalCache.put(commitUrl(BUILD_ID), new Response(JSON.stringify({
        schemaVersion: 1,
        buildId: BUILD_ID,
        committedAt: Date.now(),
        paths: [...expectedPaths],
      }), { headers: { "Content-Type": "application/json" } }));
    } catch (error) {
      await caches.delete(finalCacheName);
      throw error;
    }

    await caches.delete(stageCacheName);
  } catch (error) {
    await Promise.allSettled([caches.delete(stageCacheName), caches.delete(finalCacheName)]);
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    if (!/^[a-f0-9]{16,64}$/i.test(BUILD_ID)) {
      throw new Error("The service worker was not built with a release ID.");
    }
    const manifestResponse = await fetch(resolveUrl(MANIFEST_NAME), { cache: "no-store" });
    if (!manifestResponse.ok) {
      throw new Error(`Failed to fetch offline manifest: HTTP ${manifestResponse.status}`);
    }
    const manifest = await manifestResponse.json();
    const expectedPaths = validateManifest(manifest);
    await stageAndCommitBuild(manifest, expectedPaths);
  })());
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (message?.type === "GET_BUILD_ID") {
    event.ports[0]?.postMessage({ type: "PWA_BUILD_ID", buildId: BUILD_ID });
    return;
  }
  if (message?.type === "PIN_BUILD") {
    const clientId = event.source && "id" in event.source ? event.source.id : "";
    event.waitUntil(serializeMaintenance(() => pinBuildForClient(clientId, message.buildId)));
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(serializeMaintenance(async () => {
    const names = await caches.keys();
    const stageNames = names.filter((name) => name.startsWith(STAGE_CACHE_PREFIX));
    await Promise.all(stageNames.map((name) => caches.delete(name)));

    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const clientIds = new Set(clients
      .filter((client) => new URL(client.url).origin === SCOPE_URL.origin && new URL(client.url).pathname.startsWith(BASE_PATH))
      .map((client) => client.id));
    const pins = await loadPins();
    const livePins = [];
    for (const [clientId, buildId] of pins) {
      if (!clientIds.has(clientId) || typeof buildId !== "string" || !(await readCommitRecord(buildCacheName(buildId), buildId))) {
        await removePin(clientId);
      } else {
        livePins.push([clientId, buildId]);
      }
    }

    const buildNames = names.filter((name) => name.startsWith(BUILD_CACHE_PREFIX));
    const records = [];
    for (const name of buildNames) {
      const buildId = name.slice(BUILD_CACHE_PREFIX.length);
      const record = await readCommitRecord(name, buildId);
      if (record) {
        records.push({ name, buildId, committedAt: Number(record.committedAt) || 0 });
      } else {
        await caches.delete(name);
      }
    }
    records.sort((a, b) => b.committedAt - a.committedAt);

    const keep = new Set(records.slice(0, 2).map((record) => record.name));
    const currentName = buildCacheName(BUILD_ID);
    if (records.some((record) => record.name === currentName)) {
      keep.add(currentName);
    }
    for (const [, buildId] of livePins) {
      keep.add(buildCacheName(buildId));
    }
    for (const record of records) {
      if (!keep.has(record.name)) {
        await caches.delete(record.name);
      }
    }

    await self.clients.claim();
  })());
});

function buildIdFromReleaseUrl(url) {
  if (!url.pathname.startsWith(BASE_PATH)) {
    return null;
  }
  const relative = url.pathname.slice(BASE_PATH.length);
  const match = /^releases\/([a-f0-9]{16,64})\//i.exec(relative);
  return match?.[1] ?? null;
}

async function exactBuildCache(buildId) {
  if (!buildId) {
    return null;
  }
  const name = buildCacheName(buildId);
  if (!(await readCommitRecord(name, buildId))) {
    return null;
  }
  return caches.open(name);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(BASE_PATH)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      // Navigation must stay on the worker's committed release. A deployment may
      // already serve a newer index.html while its worker is still waiting.
      const currentCache = await exactBuildCache(BUILD_ID);
      const currentShell = currentCache && (await currentCache.match(resolveUrl("")) || await currentCache.match(resolveUrl("index.html")));
      if (currentShell) {
        return currentShell;
      }

      try {
        const networkResponse = await fetch(request);
        if (networkResponse?.status === 200) {
          return networkResponse;
        }
      } catch {
        // Use a network shell only if this worker has no committed shell.
      }
      return new Response("PianoMotion Studio is currently offline.", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    })());
    return;
  }

  event.respondWith((async () => {
    const urlBuildId = buildIdFromReleaseUrl(url);
    const clientBuildId = urlBuildId || (await getPinnedBuild(event.clientId)) || BUILD_ID;
    const cache = await exactBuildCache(clientBuildId);
    if (cache) {
      const cached = await cache.match(request) || await cache.match(url.href, { ignoreSearch: true });
      if (cached) {
        return cached;
      }
    }

    try {
      const networkResponse = await fetch(request);
      if (networkResponse?.status === 200) {
        return networkResponse;
      }
    } catch {
      // An asset from a different build must never be substituted here.
    }
    return new Response("Not found in this application build's offline cache.", { status: 404 });
  })());
});
