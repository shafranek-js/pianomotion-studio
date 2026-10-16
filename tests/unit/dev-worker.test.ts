import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { unregisterDevelopmentServiceWorker } from "../../apps/client/src/pwa/registerServiceWorker";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("development worker retirement", () => {
  it("unregisters only the exact app scope and script without deleting any data", async () => {
    vi.stubEnv("DEV", true);
    vi.stubGlobal("location", { origin: "http://localhost" });
    const own = { scope: "http://localhost/", active: { scriptURL: "http://localhost/sw.js" }, unregister: vi.fn().mockResolvedValue(true) };
    const other = { scope: "http://localhost/other/", active: { scriptURL: "http://localhost/other/sw.js" }, unregister: vi.fn() };
    const unrelated = { scope: "http://localhost/", active: { scriptURL: "http://localhost/foreign-worker.js" }, unregister: vi.fn() };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([own, other, unrelated]) } });
    await unregisterDevelopmentServiceWorker();
    expect(own.unregister).toHaveBeenCalledOnce();
    expect(other.unregister).not.toHaveBeenCalled();
    expect(unrelated.unregister).not.toHaveBeenCalled();
  });

  it("leaves production registrations alone", async () => {
    vi.stubEnv("DEV", false);
    const getRegistrations = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: { getRegistrations } });
    await unregisterDevelopmentServiceWorker();
    expect(getRegistrations).not.toHaveBeenCalled();
  });

  it("an unbuilt worker installs and retires without release errors or cache access", async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const skipWaiting = vi.fn().mockResolvedValue(undefined);
    const claim = vi.fn().mockResolvedValue(undefined);
    const unregister = vi.fn().mockResolvedValue(true);
    const caches = new Proxy({}, { get() { throw new Error("Development worker touched caches"); } });
    runInNewContext(readFileSync("apps/client/public/sw.js", "utf8"), {
      URL, btoa: (text: string) => Buffer.from(text).toString("base64"), caches,
      self: { registration: { scope: "http://localhost/", unregister }, clients: { claim }, skipWaiting,
        addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => listeners.set(type, handler) },
    });
    let install: Promise<void> | undefined; let activate: Promise<void> | undefined;
    listeners.get("install")!({ waitUntil: (promise: Promise<void>) => { install = promise; } });
    await install;
    listeners.get("activate")!({ waitUntil: (promise: Promise<void>) => { activate = promise; } });
    await activate;
    const respondWith = vi.fn();
    listeners.get("fetch")!({ request: { method: "GET", url: "http://localhost/" }, respondWith });
    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(respondWith).not.toHaveBeenCalled();
  });
});
