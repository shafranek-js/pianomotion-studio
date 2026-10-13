/// <reference lib="webworker" />
/* global self, caches */

const SHELL_CACHE = "pianomotion-shell-v1";
const PYODIDE_CACHE = "pianomotion-pyodide-v1";

const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon.svg",
];

// Install event: pre-cache core application shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
});

// Message event: allow skipWaiting on explicit demand
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Activate event: delete obsolete caches and claim existing clients
self.addEventListener("activate", (event) => {
  const currentCaches = [SHELL_CACHE, PYODIDE_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => !currentCaches.includes(cacheName))
            .map((cacheName) => caches.delete(cacheName))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch event: apply tailored caching strategies
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Skip non-GET requests
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // Skip Vite internal development requests
  if (
    url.pathname.startsWith("/@") ||
    url.pathname.startsWith("/src/") ||
    url.searchParams.has("t")
  ) {
    return;
  }

  // Navigation requests: Network-first with cache fallback to /index.html
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Hashed static assets & Pyodide runtime files: Cache-first with network fallback
  const isPyodideAsset =
    url.pathname.startsWith("/pyodide/") || url.pathname.startsWith("/python-core/");
  const isHashedAsset = url.pathname.startsWith("/assets/");

  if (isPyodideAsset || isHashedAsset) {
    const targetCache = isPyodideAsset ? PYODIDE_CACHE : SHELL_CACHE;
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(targetCache).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // Other same-origin requests: Network-first with cache fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(request))
    );
    return;
  }
});
