import { expect, test } from "@playwright/test";

test.describe("Production PWA deployment", () => {
  test("manifest link exists and serves valid PWA Web App Manifest JSON", async ({
    page,
    request,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/");

    // 1. Verify link element in DOM head
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveAttribute("href", /manifest\.webmanifest$/);
    const manifestHref = await manifestLink.getAttribute("href");
    if (!manifestHref) throw new Error("The application manifest link has no URL.");
    if (process.env.PLAYWRIGHT_PWA_PRODUCTION === "1") {
      expect(manifestHref).toMatch(/^\/releases\/[a-f0-9]{24}\/manifest\.webmanifest$/);
    }

    // 2. Fetch manifest resource directly
    const response = await request.get(new URL(manifestHref, page.url()).href);
    expect(response.status()).toBe(200);

    const manifest = await response.json();
    expect(manifest.name).toBe("PianoMotion Studio");
    expect(manifest.short_name).toBe("PianoMotion");
    expect(manifest.display).toBe("standalone");
    expect(new URL(manifest.start_url, response.url()).pathname).toBe("/");
    expect(manifest.background_color).toBe("#111516");
    expect(manifest.theme_color).toBe("#111516");

    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);

    const iconUrls = manifest.icons.map((icon: { src: string }) => new URL(icon.src, response.url()).href);
    expect(iconUrls).toHaveLength(manifest.icons.length);
    if (process.env.PLAYWRIGHT_PWA_PRODUCTION === "1") {
      expect(iconUrls.every((url: string) => /\/releases\/[a-f0-9]{24}\/icons\//.test(new URL(url).pathname))).toBe(true);
    }

    expect(pageErrors).toEqual([]);
  });

  test("PWA application icons load with valid headers and image payloads", async ({
    request,
    page,
  }) => {
    await page.goto("/");
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    if (!manifestHref) throw new Error("The application manifest link has no URL.");
    const manifestResponse = await request.get(new URL(manifestHref, page.url()).href);
    expect(manifestResponse.status()).toBe(200);
    const manifest = await manifestResponse.json();
    const iconUrls = manifest.icons.map((icon: { src: string }) => new URL(icon.src, manifestResponse.url()).href);

    // 1. Vector SVG icon
    const svgRes = await request.get(iconUrls.find((url: string) => url.endsWith("icon.svg"))!);
    expect(svgRes.status()).toBe(200);
    const svgText = await svgRes.text();
    expect(svgText).toContain("<svg");
    expect(svgText).toContain("</svg>");

    // 2. 192x192 PNG icon
    const png192Res = await request.get(iconUrls.find((url: string) => url.endsWith("icon-192.png"))!);
    expect(png192Res.status()).toBe(200);
    const png192Body = await png192Res.body();
    expect(png192Body.length).toBeGreaterThan(100);
    // PNG magic header: 0x89 0x50 0x4E 0x47
    expect(png192Body[0]).toBe(0x89);
    expect(png192Body[1]).toBe(0x50);
    expect(png192Body[2]).toBe(0x4e);
    expect(png192Body[3]).toBe(0x47);

    // 3. 512x512 PNG icon
    const png512Res = await request.get(iconUrls.find((url: string) => url.endsWith("icon-512.png"))!);
    expect(png512Res.status()).toBe(200);
    const png512Body = await png512Res.body();
    expect(png512Body.length).toBeGreaterThan(100);
    expect(png512Body[0]).toBe(0x89);
    expect(png512Body[1]).toBe(0x50);
    expect(png512Body[2]).toBe(0x4e);
    expect(png512Body[3]).toBe(0x47);
  });

  test("Service Worker registers and installs correctly in browser context", async ({
    page,
  }) => {
    test.skip(process.env.PLAYWRIGHT_PWA_PRODUCTION !== "1", "The development server intentionally disables service worker registration.");
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/");

    // Wait for window load and service worker registration
    await page.waitForLoadState("networkidle");

    await expect.poll(async () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const buildId = document.documentElement.dataset.releaseBuildId;
      const cacheNames = await caches.keys();
      return {
        registered: Boolean(registration),
        state: registration?.active?.state || registration?.installing?.state || registration?.waiting?.state,
        controlled: Boolean(navigator.serviceWorker.controller),
        hasBuildCache: Boolean(buildId && cacheNames.includes(`pianomotion-root-build-${buildId}`)),
      };
    }), { timeout: 90_000, intervals: [100, 250, 500, 1_000] }).toMatchObject({
      registered: true,
      state: "activated",
      controlled: true,
      hasBuildCache: true,
    });

    const swInfo = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) {
        return { supported: false };
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const ready = await navigator.serviceWorker.ready;
        return {
          supported: true,
          registered: Boolean(reg),
          scope: reg?.scope,
          state: ready.active?.state || reg?.active?.state || reg?.installing?.state || reg?.waiting?.state,
          controlled: Boolean(navigator.serviceWorker.controller),
          buildId: document.documentElement.dataset.releaseBuildId,
          cacheNames: await caches.keys(),
        };
      } catch (e) {
        return { supported: true, error: String(e) };
      }
    });

    expect(swInfo.supported).toBe(true);
    expect(swInfo.registered).toBe(true);
    expect(swInfo.state).toBe("activated");
    expect(swInfo.controlled).toBe(true);
    expect(swInfo.scope).toContain(new URL(page.url()).origin);
    expect(swInfo.cacheNames).toContain(`pianomotion-root-build-${swInfo.buildId}`);

    expect(pageErrors).toEqual([]);
  });

});
