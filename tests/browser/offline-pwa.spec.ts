import { expect, test } from "@playwright/test";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";
import { expectStudioCanvas, loadStudioSong, saveStudioProject, settledStudio, studioMidiPath } from "./studio-helpers";

const secondMidiPath = fileURLToPath(
  new URL("../fixtures/midi/synthetic-scale-chords.mid", import.meta.url)
);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function createMinimalValidSf2(): ArrayBuffer {
  const buffer = new ArrayBuffer(256);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 248, true);
  bytes.set(new TextEncoder().encode("sfbk"), 8);

  bytes.set(new TextEncoder().encode("LIST"), 12);
  view.setUint32(16, 24, true);
  bytes.set(new TextEncoder().encode("INFO"), 20);
  bytes.set(new TextEncoder().encode("INAM"), 24);
  view.setUint32(28, 8, true);
  bytes.set(new TextEncoder().encode("TestSF2\0"), 32);

  bytes.set(new TextEncoder().encode("LIST"), 44);
  view.setUint32(48, 32, true);
  bytes.set(new TextEncoder().encode("sdta"), 52);
  bytes.set(new TextEncoder().encode("smpl"), 56);
  view.setUint32(60, 20, true);
  for (let index = 0; index < 10; index += 1) view.setInt16(64 + index * 2, index * 100, true);

  bytes.set(new TextEncoder().encode("LIST"), 84);
  view.setUint32(88, 58, true);
  bytes.set(new TextEncoder().encode("pdta"), 92);
  bytes.set(new TextEncoder().encode("shdr"), 96);
  view.setUint32(100, 46, true);
  const sampleHeader = 104;
  bytes.set(new TextEncoder().encode("Sample1\0\0\0\0\0\0\0\0\0\0\0\0\0"), sampleHeader);
  view.setUint32(sampleHeader + 20, 0, true);
  view.setUint32(sampleHeader + 24, 10, true);
  view.setUint32(sampleHeader + 28, 0, true);
  view.setUint32(sampleHeader + 32, 10, true);
  view.setUint32(sampleHeader + 36, 44_100, true);
  view.setUint8(sampleHeader + 40, 60);
  view.setInt8(sampleHeader + 41, 0);
  view.setUint16(sampleHeader + 44, 1, true);
  return buffer;
}

type PwaTestServer = {
  origin: string;
  setBuildRoot: (root: string) => void;
  setRouteRoot: (basePath: string, root: string) => void;
  setCorruptPath: (path: string | null) => void;
  setTruncatePath: (path: string | null) => void;
  setFinalPutFailure: (enabled: boolean) => void;
  close: () => Promise<void>;
};

function mimeTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mid": "audio/midi",
    ".whl": "application/octet-stream",
    ".zip": "application/zip",
    ".py": "text/plain; charset=utf-8",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function startPwaServer(initialRoot: string): Promise<PwaTestServer> {
  const routeRoots = new Map<string, string>([["/", path.resolve(initialRoot)]]);
  let corruptPath: string | null = null;
  let truncatePath: string | null = null;
  let failFinalPut = false;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const mountPath = [...routeRoots.keys()]
        .sort((left, right) => right.length - left.length)
        .find((basePath) => requestUrl.pathname.startsWith(basePath));
      if (!mountPath) {
        response.writeHead(404).end("Not found");
        return;
      }
      const buildRoot = routeRoots.get(mountPath)!;
      const relativePath = decodeURIComponent(requestUrl.pathname.slice(mountPath.length)).replace(/^\/+/, "") || "index.html";
      let filePath = path.resolve(buildRoot, relativePath);
      const pathFromRoot = path.relative(buildRoot, filePath);
      if (pathFromRoot.startsWith("..") || path.isAbsolute(pathFromRoot)) {
        response.writeHead(403).end();
        return;
      }

      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = path.join(filePath, "index.html");
        let contents: Buffer | undefined;
        if (corruptPath === relativePath) {
          contents = await readFile(filePath);
          if (contents.byteLength > 0) contents[0] = contents[0]! ^ 0xff;
        } else if (truncatePath === relativePath) {
          const original = await readFile(filePath);
          contents = original.subarray(0, Math.max(0, original.byteLength - 1));
        }
        if (relativePath === "sw.js" && failFinalPut) {
          contents = await readFile(filePath);
          let source = contents.toString("utf8");
          const loopAnchor = "      for (const request of stagedRequests) {";
          const putAnchor = "        await finalCache.put(request, response);";
          if (!source.includes(loopAnchor) || !source.includes(putAnchor)) {
            throw new Error("The built worker no longer exposes the final-cache promotion point for fault injection.");
          }
          source = source.replace(loopAnchor, `      let __pwaTestFinalPutCount = 0;\n${loopAnchor}`);
          source = source.replace(putAnchor, `        __pwaTestFinalPutCount += 1;\n        if (__pwaTestFinalPutCount === 2) throw new DOMException("Simulated final-cache put failure", "QuotaExceededError");\n${putAnchor}`);
          contents = Buffer.from(source);
        }
        response.writeHead(200, {
          "Content-Type": mimeTypeFor(filePath),
          "Cache-Control": relativePath === "sw.js" || corruptPath === relativePath || truncatePath === relativePath ? "no-store" : "no-cache",
        });
        if (contents) response.end(contents);
        else createReadStream(filePath).pipe(response);
      } catch {
        if (!response.headersSent) response.writeHead(404, { "Cache-Control": "no-store" });
        response.end("Not found");
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not bind the temporary PWA test server."));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        setBuildRoot: (root) => { routeRoots.set("/", path.resolve(root)); },
        setRouteRoot: (basePath, root) => {
          const normalized = basePath.startsWith("/") ? basePath : `/${basePath}`;
          routeRoots.set(normalized.endsWith("/") ? normalized : `${normalized}/`, path.resolve(root));
        },
        setCorruptPath: (value) => { corruptPath = value; },
        setTruncatePath: (value) => { truncatePath = value; },
        setFinalPutFailure: (enabled) => { failFinalPut = enabled; },
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

function buildRelease(outDir: string, tag: string, appBase = "/"): Promise<void> {
  const script = path.join(repositoryRoot, "tools", "build-release.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--outDir", outDir], {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        APP_BASE: appBase,
        NODE_ENV: "development",
        PIANOMOTION_TEST_BUILD: "1",
        RELEASE_BUILD_TAG: tag,
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`PWA release build ${tag} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

async function waitForControlledRelease(
  page: import("@playwright/test").Page,
  origin: string,
  expectedBuildId: string,
  appBase = "/",
) {
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    diagnostics.push(`request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`);
  });
  await page.goto(`${origin}${appBase}`);
  await expect(page).toHaveTitle("PianoMotion Studio");
  await expect.poll(async () => page.evaluate(async (scopePath) => {
    const registration = await navigator.serviceWorker.getRegistration(scopePath);
    return {
      buildId: document.documentElement.dataset.releaseBuildId ?? null,
      activeState: registration?.active?.state ?? null,
      installingState: registration?.installing?.state ?? null,
      waitingState: registration?.waiting?.state ?? null,
      controlled: Boolean(navigator.serviceWorker.controller),
    };
  }, appBase).then((state) => ({ ...state, diagnostics: diagnostics.slice(-5) })), { timeout: 20_000, intervals: [100, 250, 500, 1_000] }).toEqual({
    buildId: expectedBuildId,
    activeState: "activated",
    installingState: null,
    waitingState: null,
    controlled: true,
    diagnostics: [],
  });
}

async function requestWorkerUpdate(page: import("@playwright/test").Page): Promise<"installed" | "redundant"> {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) throw new Error("No service worker registration is available.");
    const stateWindow = window as Window & { __pwaTestUpdateState?: "installed" | "redundant" | "pending" };
    stateWindow.__pwaTestUpdateState = "pending";
    const updateFinished = new Promise<"installed" | "redundant">((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Timed out waiting for the updated worker to install.")), 90_000);
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        if (!worker) return;
        const inspect = () => {
          if (worker.state === "installed" || worker.state === "redundant") {
            window.clearTimeout(timeout);
            stateWindow.__pwaTestUpdateState = worker.state;
            resolve(worker.state);
          }
        };
        worker.addEventListener("statechange", inspect);
        inspect();
      }, { once: true });
    });
    await reg.update();
    return updateFinished;
  });
}

async function askWorkerBuildId(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(async () => {
    const worker = navigator.serviceWorker.controller;
    if (!worker) throw new Error("The page is not controlled by a service worker.");
    return new Promise<string>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => reject(new Error("Timed out reading the active worker build ID.")), 5_000);
      channel.port1.onmessage = (event: MessageEvent<{ type?: string; buildId?: string }>) => {
        window.clearTimeout(timeout);
        channel.port1.close();
        if (event.data?.type !== "PWA_BUILD_ID" || !event.data.buildId) {
          reject(new Error("The active service worker returned an invalid build ID."));
        } else {
          resolve(event.data.buildId);
        }
      };
      worker.postMessage({ type: "GET_BUILD_ID" }, [channel.port2]);
    });
  });
}

test("SoundFont save and delete reject IndexedDB aborts after request success", async ({ browser }) => {
  test.setTimeout(90_000);
  let viteServer: ViteDevServer | undefined;
  const browserContext = await browser.newContext();

  try {
    viteServer = await createViteServer({
      configFile: path.join(repositoryRoot, "apps", "client", "vite.config.ts"),
      clearScreen: false,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not bind a Vite server for the IndexedDB browser regression.");
    }

    const page = await browserContext.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const sf2Bytes = Array.from(new Uint8Array(createMinimalValidSf2()));
    const result = await page.evaluate(async (bytes) => {
      const store = await import("/src/audio/soundfont/soundfontAssetStore.ts");
      const array = Uint8Array.from(bytes);
      const abortedAssetId = await store.computeSha256Hex(array.buffer);
      const prototype = IDBObjectStore.prototype as unknown as {
        put: (...args: unknown[]) => IDBRequest;
        delete: (...args: unknown[]) => IDBRequest;
      };
      const originalPut = prototype.put;
      const originalDelete = prototype.delete;
      prototype.put = function (this: IDBObjectStore, ...args: unknown[]) {
        const request = originalPut.apply(this, args);
        if (this.name === "assets") {
          const transaction = this.transaction;
          request.addEventListener("success", () => queueMicrotask(() => transaction.abort()), { once: true });
        }
        return request;
      };

      let saveRejected = false;
      try {
        await store.saveSoundFontAsset("aborted.sf2", array.buffer);
      } catch (error) {
        saveRejected = /abort/i.test(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      } finally {
        prototype.put = originalPut;
      }
      const missingAfterSaveAbort = await store.loadSoundFontAsset(abortedAssetId);
      const saved = await store.saveSoundFontAsset("kept.sf2", array.buffer);

      prototype.delete = function (this: IDBObjectStore, ...args: unknown[]) {
        const request = originalDelete.apply(this, args);
        if (this.name === "assets") {
          const transaction = this.transaction;
          request.addEventListener("success", () => queueMicrotask(() => transaction.abort()), { once: true });
        }
        return request;
      };
      let deleteRejected = false;
      try {
        await store.deleteSoundFontAsset(saved.id);
      } catch (error) {
        deleteRejected = /abort/i.test(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      } finally {
        prototype.delete = originalDelete;
      }
      const retainedAfterDeleteAbort = await store.loadSoundFontAsset(saved.id);
      store.closeSoundFontDb();
      return {
        saveRejected,
        missingAfterSaveAbort: missingAfterSaveAbort === null,
        deleteRejected,
        retainedAfterDeleteAbort: retainedAfterDeleteAbort !== null,
      };
    }, sf2Bytes);

    expect(result).toEqual({
      saveRejected: true,
      missingAfterSaveAbort: true,
      deleteRejected: true,
      retainedAfterDeleteAbort: true,
    });
  } finally {
    await browserContext.close();
    await viteServer?.close();
  }
});

test("production offline lifecycle: online analysis -> close -> offline reload -> restore -> offline new MIDI import -> save", async ({
  context,
}) => {
  test.setTimeout(180_000);

  // 1. Online session start
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  // Seed a foreign cache on this origin to verify namespace isolation
  await page.goto("/?empty=true");
  await page.evaluate(async () => {
    const foreignCache = await caches.open("foreign-isolated-cache-v1");
    await foreignCache.put(
      new Request("https://example.com/foreign-dummy"),
      new Response("foreign data")
    );
  });

  // Wait for Service Worker registration and activation
  await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) throw new Error("Service Worker not supported");
    const reg = await navigator.serviceWorker.ready;
    if (!reg.active) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      });
    }
  });

  // Verify that SW cached our app under pianomotion-root-build-*
  const cacheNames = await page.evaluate(async () => caches.keys());
  const ourBuildCaches = cacheNames.filter((name) => name.startsWith("pianomotion-root-build-"));
  expect(ourBuildCaches.length).toBeGreaterThanOrEqual(1);

  // Verify foreign cache is preserved
  expect(cacheNames).toContain("foreign-isolated-cache-v1");

  // Load first song online and save project
  const initial = await loadStudioSong(page);
  expect(initial.result.document?.durationSeconds).toBeGreaterThan(0);
  await saveStudioProject(page);

  // 2. Close page and go offline
  await page.close();
  await context.setOffline(true);

  // 3. Open new page offline: verify offline navigation & session restoration
  const offlinePage = await context.newPage();
  const offlineErrors: string[] = [];
  offlinePage.on("pageerror", (err) => offlineErrors.push(err.message));

  await offlinePage.goto("/");
  await expect(offlinePage).toHaveTitle("PianoMotion Studio");

  // Verify offline session restored previous project
  await settledStudio(offlinePage, initial.result.revision);
  await expectStudioCanvas(offlinePage);

  // 4. Import a different MIDI while offline to prove self-hosted Pyodide & python-core work offline
  await offlinePage.locator("#midi-file").setInputFiles(secondMidiPath);
  await expect
    .poll(async () => {
      return await offlinePage.evaluate(() => window.__playerSnapshot?.result.projectId);
    }, { timeout: 90_000 })
    .not.toBe(initial.result.projectId);

  const secondResult = await settledStudio(offlinePage, 0);
  expect(secondResult.result.projectId).not.toBe(initial.result.projectId);
  expect(secondResult.result.document?.notes.length).toBeGreaterThan(0);

  // Save the second project offline
  await saveStudioProject(offlinePage);

  // 5. Verify caches on offlinePage: foreign cache still intact, no leaky deletions
  const offlineCacheNames = await offlinePage.evaluate(async () => caches.keys());
  expect(offlineCacheNames).toContain("foreign-isolated-cache-v1");
  expect(offlineCacheNames.some((c) => c.startsWith("pianomotion-root-build-"))).toBe(true);

  // 6. Go back online and check error logs
  await context.setOffline(false);
  expect(errors).toEqual([]);
  expect(offlineErrors).toEqual([]);
});

test("three real releases preserve pinned old tabs and roll back corrupt and partial installs", async ({ context }) => {
  test.setTimeout(300_000);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pianomotion-pwa-releases-"));
  const releaseAPath = path.join(temporaryRoot, "release-a");
  const releaseBPath = path.join(temporaryRoot, "release-b");
  const releaseCPath = path.join(temporaryRoot, "release-c");
  let server: PwaTestServer | undefined;

  try {
    await buildRelease(releaseAPath, "pwa-two-build-a");
    await buildRelease(releaseBPath, "pwa-two-build-b");
    await buildRelease(releaseCPath, "pwa-two-build-c");
    const releaseAManifest = JSON.parse(await readFile(path.join(releaseAPath, "offline-manifest.json"), "utf8")) as {
      buildId: string;
      files: Array<{ path: string }>;
    };
    const releaseBManifest = JSON.parse(await readFile(path.join(releaseBPath, "offline-manifest.json"), "utf8")) as {
      buildId: string;
      files: Array<{ path: string }>;
    };
    const releaseCManifest = JSON.parse(await readFile(path.join(releaseCPath, "offline-manifest.json"), "utf8")) as {
      buildId: string;
      files: Array<{ path: string }>;
    };
    const releaseA = releaseAManifest.buildId;
    const releaseB = releaseBManifest.buildId;
    const releaseC = releaseCManifest.buildId;
    expect(releaseA).not.toBe(releaseB);
    expect(new Set([releaseA, releaseB, releaseC]).size).toBe(3);
    expect(releaseAManifest.files.some((file) => file.path === `releases/${releaseA}/python-core/handthesia_core/__init__.py`)).toBe(true);
    expect(releaseBManifest.files.some((file) => file.path === `releases/${releaseB}/python-core/handthesia_core/__init__.py`)).toBe(true);

    server = await startPwaServer(releaseAPath);
    const tabA = await context.newPage();
    const tabA2 = await context.newPage();
    await Promise.all([
      waitForControlledRelease(tabA, server.origin, releaseA),
      waitForControlledRelease(tabA2, server.origin, releaseA),
    ]);
    console.log("PWA update regression: release A controls both tabs.");
    expect(await askWorkerBuildId(tabA)).toBe(releaseA);
    await tabA.evaluate(async () => {
      const cache = await caches.open("foreign-isolated-cache-v1");
      await cache.put(new Request(new URL("foreign-dummy", location.origin)), new Response("foreign data"));
    });

    // A valid hash manifest still rejects a resource whose downloaded bytes were corrupted.
    server.setBuildRoot(releaseBPath);
    await tabA.reload();
    await expect(tabA.locator("html")).toHaveAttribute("data-release-build-id", releaseA);
    expect(await askWorkerBuildId(tabA)).toBe(releaseA);
    console.log("PWA update regression: A remains the navigation shell while B is only served by the origin.");
    server.setCorruptPath(`releases/${releaseB}/python-core/handthesia_core/__init__.py`);
    expect(await requestWorkerUpdate(tabA)).toBe("redundant");
    expect(await askWorkerBuildId(tabA)).toBe(releaseA);
    console.log("PWA update regression: corrupt release B was rejected.");
    const afterCorruptInstall = await tabA.evaluate(async () => caches.keys());
    expect(afterCorruptInstall).not.toContain(`pianomotion-root-build-${releaseB}`);
    expect(afterCorruptInstall.some((name) => name.includes(`-stage-${releaseB}`))).toBe(false);

    // A truncated response is rejected against the manifest's exact size before hashing.
    server.setCorruptPath(null);
    server.setTruncatePath(`releases/${releaseB}/python-core/handthesia_core/__init__.py`);
    expect(await requestWorkerUpdate(tabA)).toBe("redundant");
    expect(await askWorkerBuildId(tabA)).toBe(releaseA);
    console.log("PWA update regression: a truncated release resource was rejected by the manifest size.");
    const afterTruncatedInstall = await tabA.evaluate(async () => caches.keys());
    expect(afterTruncatedInstall).not.toContain(`pianomotion-root-build-${releaseB}`);
    expect(afterTruncatedInstall.some((name) => name.includes(`-stage-${releaseB}`))).toBe(false);

    // Fail the second write to the final build cache after one final entry was already promoted.
    server.setTruncatePath(null);
    server.setFinalPutFailure(true);
    expect(await requestWorkerUpdate(tabA)).toBe("redundant");
    expect(await askWorkerBuildId(tabA)).toBe(releaseA);
    console.log("PWA update regression: partial final-cache promotion rolled back.");
    const afterFinalPutFailure = await tabA.evaluate(async () => caches.keys());
    expect(afterFinalPutFailure).not.toContain(`pianomotion-root-build-${releaseB}`);
    expect(afterFinalPutFailure.some((name) => name.includes(`-stage-${releaseB}`))).toBe(false);

    // Retry with an unmodified production worker: the partial final cache must not be treated as complete.
    server.setFinalPutFailure(false);
    expect(await requestWorkerUpdate(tabA)).toBe("installed");
    console.log("PWA update regression: clean release B installed after retry.");
    const waitingState = await tabA.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.waiting?.state ?? null);
    expect(waitingState).toBe("installed");
    const completeBuildCache = await tabA.evaluate(async (buildId) => {
      const cache = await caches.open(`pianomotion-root-build-${buildId}`);
      const markerUrl = new URL(`__pwa-meta__/committed-${buildId}.json`, location.origin).href;
      const markerResponse = await cache.match(markerUrl);
      if (!markerResponse) return false;
      const marker = await markerResponse.json() as { buildId?: string; paths?: string[] };
      if (marker.buildId !== buildId || !Array.isArray(marker.paths)) return false;
      const resources = await Promise.all(marker.paths.map((filePath) => cache.match(new URL(filePath, location.origin).href)));
      return resources.every(Boolean);
    }, releaseB);
    expect(completeBuildCache).toBe(true);

    await tabA.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const waiting = registration?.waiting;
      if (!waiting) throw new Error("Expected the verified second release to be waiting.");
      const controlled = new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      });
      waiting.postMessage({ type: "SKIP_WAITING" });
      await controlled;
    });
    await expect.poll(() => askWorkerBuildId(tabA)).toBe(releaseB);
    await expect.poll(() => askWorkerBuildId(tabA2)).toBe(releaseB);
    console.log("PWA update regression: B controls existing tabs after skip-waiting.");
    await expect(tabA.locator("html")).toHaveAttribute("data-release-build-id", releaseA);
    await expect(tabA2.locator("html")).toHaveAttribute("data-release-build-id", releaseA);

    await tabA.reload();
    await expect(tabA.locator("html")).toHaveAttribute("data-release-build-id", releaseB);
    expect(await askWorkerBuildId(tabA)).toBe(releaseB);
    console.log("PWA update regression: the activated B worker serves B on the next navigation.");

    // A is older than the normal previous-release window, so its still-open tab must pin it
    // while B's tab remains open and a third release activates.
    server.setBuildRoot(releaseCPath);
    expect(await requestWorkerUpdate(tabA)).toBe("installed");
    expect(await askWorkerBuildId(tabA)).toBe(releaseB);
    const completeCBuildCache = await tabA.evaluate(async (buildId) => {
      const cache = await caches.open(`pianomotion-root-build-${buildId}`);
      const markerUrl = new URL(`__pwa-meta__/committed-${buildId}.json`, location.origin).href;
      const markerResponse = await cache.match(markerUrl);
      if (!markerResponse) return false;
      const marker = await markerResponse.json() as { buildId?: string; paths?: string[] };
      if (marker.buildId !== buildId || !Array.isArray(marker.paths)) return false;
      const resources = await Promise.all(marker.paths.map((filePath) => cache.match(new URL(filePath, location.origin).href)));
      return resources.every(Boolean);
    }, releaseC);
    expect(completeCBuildCache).toBe(true);
    await tabA.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const waiting = registration?.waiting;
      if (!waiting) throw new Error("Expected the verified third release to be waiting.");
      const controlled = new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      });
      waiting.postMessage({ type: "SKIP_WAITING" });
      await controlled;
    });
    await expect.poll(() => askWorkerBuildId(tabA)).toBe(releaseC);
    await expect.poll(() => askWorkerBuildId(tabA2)).toBe(releaseC);
    await expect(tabA.locator("html")).toHaveAttribute("data-release-build-id", releaseB);
    await expect(tabA2.locator("html")).toHaveAttribute("data-release-build-id", releaseA);
    console.log("PWA update regression: C controls the live A and B tabs without replacing either tab's running shell.");

    await expect.poll(async () => tabA.evaluate(async () => {
      const cache = await caches.open("pianomotion-root-meta-v1");
      const prefix = new URL("__pwa-meta__/client-pins/", location.origin).pathname;
      const records = await Promise.all((await cache.keys())
        .filter((request) => new URL(request.url).pathname.startsWith(prefix))
        .map(async (request) => (await cache.match(request))?.json() as Promise<{ buildId?: string } | undefined>));
      return [...new Set(records.map((record) => record?.buildId).filter((value): value is string => Boolean(value)))].sort();
    })).toEqual([releaseA, releaseB].sort());

    const retainedCaches = await tabA.evaluate(async () => caches.keys());
    expect(retainedCaches).toContain(`pianomotion-root-build-${releaseA}`);
    expect(retainedCaches).toContain(`pianomotion-root-build-${releaseB}`);
    expect(retainedCaches).toContain(`pianomotion-root-build-${releaseC}`);
    expect(retainedCaches).toContain("foreign-isolated-cache-v1");
    expect(retainedCaches.some((name) => name.includes("-stage-"))).toBe(false);

    // Old code resolves its release URLs to A; the new controller must serve A's exact cache offline.
    await context.setOffline(true);
    const oldTabAsset = await tabA2.evaluate(async (buildId) => {
      const response = await fetch(`/releases/${buildId}/python-core/handthesia_core/__init__.py`);
      return { status: response.status, body: await response.text() };
    }, releaseA);
    expect(oldTabAsset.status).toBe(200);
    expect(oldTabAsset.body.length).toBeGreaterThan(0);
    await context.setOffline(false);
    console.log("PWA update regression: old A tab loaded its pinned engine asset offline.");

    const currentTab = await context.newPage();
    await waitForControlledRelease(currentTab, server.origin, releaseC);
    expect(await askWorkerBuildId(currentTab)).toBe(releaseC);
  } finally {
    await server?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the exact /pianomotion/ base imports, saves, and restores a project offline", async ({ context }) => {
  test.setTimeout(300_000);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pianomotion-pwa-releases-basepath-"));
  const releasePath = path.join(temporaryRoot, "release-pianomotion");
  const appBase = "/pianomotion/";
  let server: PwaTestServer | undefined;

  try {
    await buildRelease(releasePath, "pwa-scope-pianomotion", appBase);
    const manifest = JSON.parse(await readFile(path.join(releasePath, "offline-manifest.json"), "utf8")) as { buildId: string };
    const webManifest = JSON.parse(await readFile(path.join(releasePath, "releases", manifest.buildId, "manifest.webmanifest"), "utf8")) as {
      start_url?: string;
      scope?: string;
    };
    expect(webManifest.start_url).toBe(appBase);
    expect(webManifest.scope).toBe(appBase);

    server = await startPwaServer(releasePath);
    server.setRouteRoot(appBase, releasePath);
    const page = await context.newPage();
    await waitForControlledRelease(page, server.origin, manifest.buildId, appBase);
    const scopePaths = await page.evaluate(async () =>
      (await navigator.serviceWorker.getRegistrations()).map((registration) => new URL(registration.scope).pathname),
    );
    expect(scopePaths).toContain(appBase);

    await page.goto(`${server.origin}${appBase}?empty=true`);
    await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled();
    await page.locator("#midi-file").setInputFiles(studioMidiPath);
    await expect.poll(async () => page.evaluate(() => window.__playerSnapshot?.result.document?.notes.length ?? 0), { timeout: 90_000 }).toBeGreaterThan(0);
    const imported = await settledStudio(page, 0);
    await saveStudioProject(page);

    await context.setOffline(true);
    const restoredPage = await context.newPage();
    await restoredPage.goto(`${server.origin}${appBase}`);
    await expect(restoredPage).toHaveTitle("PianoMotion Studio");
    await settledStudio(restoredPage, imported.result.revision);
    await expectStudioCanvas(restoredPage);
    const restoredProjectId = await restoredPage.evaluate(() => window.__playerSnapshot?.result.projectId ?? null);
    expect(restoredProjectId).toBe(imported.result.projectId);
    await context.setOffline(false);
  } finally {
    await context.setOffline(false);
    await server?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("subpath releases use distinct service-worker scopes and cache namespaces", async ({ context }) => {
  test.setTimeout(300_000);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pianomotion-pwa-releases-scopes-"));
  const nestedBase = "/a/b/";
  const flatBase = "/a_b/";
  const nestedPath = path.join(temporaryRoot, "release-nested");
  const flatPath = path.join(temporaryRoot, "release-flat");
  let server: PwaTestServer | undefined;

  try {
    await buildRelease(nestedPath, "pwa-scope-nested", nestedBase);
    await buildRelease(flatPath, "pwa-scope-flat", flatBase);
    const nestedManifest = JSON.parse(await readFile(path.join(nestedPath, "offline-manifest.json"), "utf8")) as { buildId: string };
    const flatManifest = JSON.parse(await readFile(path.join(flatPath, "offline-manifest.json"), "utf8")) as { buildId: string };
    expect(nestedManifest.buildId).not.toBe(flatManifest.buildId);

    server = await startPwaServer(nestedPath);
    server.setRouteRoot(nestedBase, nestedPath);
    server.setRouteRoot(flatBase, flatPath);
    const nestedPage = await context.newPage();
    const flatPage = await context.newPage();
    await Promise.all([
      waitForControlledRelease(nestedPage, server.origin, nestedManifest.buildId, nestedBase),
      waitForControlledRelease(flatPage, server.origin, flatManifest.buildId, flatBase),
    ]);

    const scopes = await nestedPage.evaluate(async () =>
      (await navigator.serviceWorker.getRegistrations()).map((registration) => new URL(registration.scope).pathname).sort(),
    );
    expect(scopes).toContain(nestedBase);
    expect(scopes).toContain(flatBase);
    expect(await askWorkerBuildId(nestedPage)).toBe(nestedManifest.buildId);
    expect(await askWorkerBuildId(flatPage)).toBe(flatManifest.buildId);

    const cacheNames = await nestedPage.evaluate(async () => caches.keys());
    const nestedSlug = Buffer.from(nestedBase).toString("base64url");
    const flatSlug = Buffer.from(flatBase).toString("base64url");
    expect(nestedSlug).not.toBe(flatSlug);
    expect(cacheNames).toContain(`pianomotion-scope-${nestedSlug}-build-${nestedManifest.buildId}`);
    expect(cacheNames).toContain(`pianomotion-scope-${flatSlug}-build-${flatManifest.buildId}`);
  } finally {
    await server?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

