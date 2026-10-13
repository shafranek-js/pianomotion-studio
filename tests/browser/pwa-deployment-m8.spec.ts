import { expect, test } from "@playwright/test";

test.describe("M8 Deployment, PWA & Final Polish (W050–W055, Gate G8)", () => {
  test("manifest link exists and serves valid PWA Web App Manifest JSON", async ({
    page,
    request,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/");

    // 1. Verify link element in DOM head
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveAttribute("href", "/manifest.webmanifest");

    // 2. Fetch manifest resource directly
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);

    const manifest = await response.json();
    expect(manifest.name).toBe("PianoMotion Studio");
    expect(manifest.short_name).toBe("PianoMotion");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.background_color).toBe("#111516");
    expect(manifest.theme_color).toBe("#111516");

    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);

    const iconSrcs = manifest.icons.map((icon: { src: string }) => icon.src);
    expect(iconSrcs).toContain("/icons/icon.svg");
    expect(iconSrcs).toContain("/icons/icon-192.png");
    expect(iconSrcs).toContain("/icons/icon-512.png");

    expect(pageErrors).toEqual([]);
  });

  test("PWA application icons load with valid headers and image payloads", async ({
    request,
  }) => {
    // 1. Vector SVG icon
    const svgRes = await request.get("/icons/icon.svg");
    expect(svgRes.status()).toBe(200);
    const svgText = await svgRes.text();
    expect(svgText).toContain("<svg");
    expect(svgText).toContain("</svg>");

    // 2. 192x192 PNG icon
    const png192Res = await request.get("/icons/icon-192.png");
    expect(png192Res.status()).toBe(200);
    const png192Body = await png192Res.body();
    expect(png192Body.length).toBeGreaterThan(100);
    // PNG magic header: 0x89 0x50 0x4E 0x47
    expect(png192Body[0]).toBe(0x89);
    expect(png192Body[1]).toBe(0x50);
    expect(png192Body[2]).toBe(0x4e);
    expect(png192Body[3]).toBe(0x47);

    // 3. 512x512 PNG icon
    const png512Res = await request.get("/icons/icon-512.png");
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
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/");

    // Wait for window load and service worker registration
    await page.waitForLoadState("networkidle");

    const swInfo = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) {
        return { supported: false };
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration("/");
        return {
          supported: true,
          registered: Boolean(reg),
          scope: reg?.scope,
          state: reg?.active?.state || reg?.installing?.state || reg?.waiting?.state,
        };
      } catch (e) {
        return { supported: true, error: String(e) };
      }
    });

    expect(swInfo.supported).toBe(true);
    expect(swInfo.registered).toBe(true);
    expect(swInfo.scope).toContain("127.0.0.1:4173");

    expect(pageErrors).toEqual([]);
  });

  test("Security limits and sanitization reject invalid and oversized payloads safely", async ({
    page,
  }) => {
    await page.goto("/");

    const securityChecks = await page.evaluate(async () => {
      // Dynamic import from client storage module
      const storage = await import("/src/storage/index.ts");

      // 1. Oversized MIDI check (17 MiB > 16 MiB limit)
      const oversizedMidiBlob = new Blob([new Uint8Array(10)], { type: "audio/midi" });
      Object.defineProperty(oversizedMidiBlob, "size", { value: 17 * 1024 * 1024 });
      const midiCheck = storage.validateMidiFile(oversizedMidiBlob, "huge.mid");

      // 2. Oversized Package check (33 MiB > 32 MiB limit)
      const oversizedPkgBlob = new Blob([new Uint8Array(10)], { type: "application/json" });
      Object.defineProperty(oversizedPkgBlob, "size", { value: 33 * 1024 * 1024 });
      const pkgCheck = storage.validatePackageFile(oversizedPkgBlob, "huge.json");

      // 3. Filename sanitization
      const sanitizedTraversal = storage.sanitizeFilename("../../../etc/passwd");
      const sanitizedDrive = storage.sanitizeFilename("C:\\Windows\\System32\\cmd.exe");
      const sanitizedReserved = storage.sanitizeFilename("con.mid");

      // 4. Safe Resource Path validation
      const safePath = storage.isSafeResourcePath("resources/audio.wav");
      const traversalPath = storage.isSafeResourcePath("../resources/audio.wav");
      const absolutePath = storage.isSafeResourcePath("/resources/audio.wav");

      return {
        midiCheckValid: midiCheck.valid,
        midiCheckCode: midiCheck.valid ? null : midiCheck.code,
        pkgCheckValid: pkgCheck.valid,
        pkgCheckCode: pkgCheck.valid ? null : pkgCheck.code,
        sanitizedTraversal,
        sanitizedDrive,
        sanitizedReserved,
        safePath,
        traversalPath,
        absolutePath,
      };
    });

    expect(securityChecks.midiCheckValid).toBe(false);
    expect(securityChecks.midiCheckCode).toBe("FILE_TOO_LARGE");

    expect(securityChecks.pkgCheckValid).toBe(false);
    expect(securityChecks.pkgCheckCode).toBe("FILE_TOO_LARGE");

    expect(securityChecks.sanitizedTraversal).toBe("etc/passwd".replace(/[/\\]/g, ""));
    expect(securityChecks.sanitizedDrive).not.toContain("C:");
    expect(securityChecks.sanitizedReserved).toBe("_con.mid");

    expect(securityChecks.safePath).toBe(true);
    expect(securityChecks.traversalPath).toBe(false);
    expect(securityChecks.absolutePath).toBe(false);
  });
});
