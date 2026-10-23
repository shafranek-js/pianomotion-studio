import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const BUILD_ID = "a".repeat(24);
const SCOPE = "https://example.test/pianomotion/";

function loadWorker(options: { policy?: unknown; policyStatus?: number } = {}) {
  const source = readFileSync(resolve("apps/client/public/sw.js"), "utf8")
    .replace("__PIANOMOTION_BUILD_ID__", BUILD_ID);
  const deletedCaches: string[] = [];
  const messages: unknown[] = [];
  let policyFetches = 0;
  const policy = options.policy ?? { schemaVersion: 1, revokedBuildIds: [] };
  const context = {
    self: {
      registration: { scope: SCOPE },
      clients: {
        claim: async () => {},
        matchAll: async () => [{ postMessage: (message: unknown) => messages.push(message) }],
      },
      addEventListener: () => {},
      skipWaiting: () => {},
    },
    caches: {
      delete: async (name: string) => { deletedCaches.push(name); return true; },
      keys: async () => [],
      has: async () => false,
      open: async () => ({ match: async () => undefined, put: async () => {} }),
    },
    fetch: async () => {
      policyFetches += 1;
      return new Response(JSON.stringify(policy), {
        status: options.policyStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    URL,
    Response,
    Blob,
    crypto,
    btoa,
    atob,
    console,
  };
  vm.runInNewContext(source, context);
  return {
    context: context as unknown as {
      isTrustedClient(source: { url?: string } | null): boolean;
      refreshRevocation(): Promise<boolean>;
      revokedBuild: boolean;
    },
    deletedCaches,
    messages,
    policyFetches: () => policyFetches,
  };
}

describe("SEC-4/SEC-5 service-worker guards", () => {
  it("accepts only window clients inside the worker scope", () => {
    const worker = loadWorker();
    expect(worker.context.isTrustedClient({ url: `${SCOPE}index.html` })).toBe(true);
    expect(worker.context.isTrustedClient({ url: "https://example.test/other/index.html" })).toBe(false);
    expect(worker.context.isTrustedClient({ url: "https://evil.test/pianomotion/" })).toBe(false);
    expect(worker.context.isTrustedClient(null)).toBe(false);
  });

  it("withdraws a revoked build, removes its cache, and notifies clients", async () => {
    const worker = loadWorker({ policy: { schemaVersion: 1, revokedBuildIds: [BUILD_ID] } });
    await expect(worker.context.refreshRevocation()).resolves.toBe(true);
    expect(worker.deletedCaches.some(name => name.endsWith(`-build-${BUILD_ID}`))).toBe(true);
    expect(worker.messages).toContainEqual({ type: "PWA_BUILD_REVOKED", buildId: BUILD_ID });
    await expect(worker.context.refreshRevocation()).resolves.toBe(true);
    expect(worker.policyFetches()).toBe(1);
  });

  it("keeps a healthy or unreachable policy non-revoked", async () => {
    const healthy = loadWorker();
    await expect(healthy.context.refreshRevocation()).resolves.toBe(false);
    expect(healthy.messages).toHaveLength(0);

    const unreachable = loadWorker({ policyStatus: 503 });
    await expect(unreachable.context.refreshRevocation()).resolves.toBe(false);
    expect(unreachable.messages).toHaveLength(0);
  });
});
