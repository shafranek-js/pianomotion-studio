import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { committedStudioSettings, expectStudioCanvas, settledStudio, waitForLoadingToClear } from "./studio-helpers";

type OfflineFile = { path: string; sizeBytes: number; sha256: string };
type ImprovedHandManifest = {
  schemaVersion: number;
  modelId: string;
  hands: Record<"left" | "right", { lods: Array<{ level: number; url: string }> }>;
  textures: Record<string, { baseColor: string; normal: string; roughness: string }>;
};

const appBase = "/pianomotion-studio/";
const fixturePath = fileURLToPath(new URL("../fixtures/midi/tracked-demo-song.mid", import.meta.url));

function relativeReleasePath(url: URL): string {
  expect(url.pathname.startsWith(appBase), `release asset URL must stay under ${appBase}`).toBe(true);
  return url.pathname.slice(appBase.length);
}

function countVisibleSkinPixels(png: Buffer): number {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.subarray(0, 8).equals(signature), "canvas screenshot must be a PNG").toBe(true);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      expect(chunk[8], "pixel check supports 8-bit PNGs").toBe(8);
      channels = chunk[9] === 2 ? 3 : chunk[9] === 6 ? 4 : 0;
      expect(channels, "canvas screenshots must use truecolor PNG").toBeGreaterThan(0);
      expect(chunk[12], "interlaced PNG screenshots are unsupported").toBe(0);
    } else if (type === "IDAT") {
      compressed.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const inputStart = y * (stride + 1);
    const filter = raw[inputStart]!;
    const rowStart = y * stride;
    const previousStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[inputStart + 1 + x]!;
      const left = x >= channels ? pixels[rowStart + x - channels]! : 0;
      const above = y > 0 ? pixels[previousStart + x]! : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[previousStart + x - channels]! : 0;
      const predictor = filter === 1 ? left
        : filter === 2 ? above
          : filter === 3 ? Math.floor((left + above) / 2)
            : filter === 4 ? paeth(left, above, upperLeft)
              : 0;
      pixels[rowStart + x] = (value + predictor) & 0xff;
    }
    expect(filter).toBeLessThanOrEqual(4);
  }
  let count = 0;
  for (let y = Math.floor(height * 0.35); y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * stride + x * channels;
      const red = pixels[index]!;
      const green = pixels[index + 1]!;
      const blue = pixels[index + 2]!;
      if (red > 100 && green > 55 && green < 190 && blue > 35 && blue < 175 &&
          red > green * 1.12 && green > blue * 0.85 && red - blue > 20) count++;
    }
  }
  return count;
}

test("production release persists improved hand choice and serves its immutable model assets", async ({ page, request }, testInfo) => {
  test.setTimeout(170_000);
  const pageErrors: string[] = [];
  const webglConsoleMessages: Array<{ type: string; text: string }> = [];
  const assetResponses: Array<{ url: string; status: number }> = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if ((message.type() === "error" || message.type() === "warning") &&
        /shader|vertexAttrib|WebGL.*error|GL_INVALID/i.test(message.text())) {
      webglConsoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("response", response => {
    if (response.url().includes("/models/hands/")) assetResponses.push({ url: response.url(), status: response.status() });
  });

  const indexResponse = await request.get(appBase);
  expect(indexResponse.status()).toBe(200);
  const indexHtml = await indexResponse.text();
  const scriptSrc = indexHtml.match(/<script[^>]+src="([^"]+\.js)"/i)?.[1];
  expect(scriptSrc, "release index must reference a versioned JavaScript bundle").toBeTruthy();
  const scriptPath = new URL(scriptSrc!, indexResponse.url()).pathname;
  expect((await request.get(new URL(scriptSrc!, indexResponse.url()).href)).status(), "the release JavaScript bundle must exist").toBe(200);
  const buildIdMatch = scriptPath.match(/\/releases\/([a-f0-9]{24})\/assets\//i);
  expect(buildIdMatch, "the current bundle must come from the immutable nested release directory").not.toBeNull();
  const buildId = buildIdMatch![1]!;
  const manifestLink = indexHtml.match(/<link[^>]+rel="manifest"[^>]+href="([^"]+)"/i)?.[1];
  expect(manifestLink).toContain(`/releases/${buildId}/manifest.webmanifest`);
  const webManifestResponse = await request.get(new URL(manifestLink!, indexResponse.url()).href);
  expect(webManifestResponse.status()).toBe(200);
  const webManifest = await webManifestResponse.json() as { name: string; scope: string; start_url: string; icons: Array<{ src: string }> };
  expect(webManifest).toMatchObject({ name: "PianoMotion Studio", scope: appBase, start_url: appBase });
  expect(webManifest.icons.length).toBeGreaterThanOrEqual(3);
  expect(webManifest.icons.every(icon => new URL(icon.src, webManifestResponse.url()).pathname.includes(`/releases/${buildId}/icons/`))).toBe(true);

  const offlineResponse = await request.get(`${appBase}offline-manifest.json`);
  expect(offlineResponse.status()).toBe(200);
  const offlineManifest = await offlineResponse.json() as { schemaVersion: number; buildId: string; files: OfflineFile[] };
  expect(offlineManifest).toMatchObject({ schemaVersion: 2, buildId });
  const offlinePaths = new Set(offlineManifest.files.map(file => file.path));
  const releasePrefix = `releases/${buildId}/`;
  const requiredReleasePaths = [
    `${releasePrefix}manifest.webmanifest`,
    `${releasePrefix}models/hands/improved/manifest.json`,
    `${releasePrefix}models/hands/improved/left-lod0.glb`,
    `${releasePrefix}models/hands/improved/right-lod0.glb`,
    `${releasePrefix}models/hands/improved/left-lod1.glb`,
    `${releasePrefix}models/hands/improved/right-lod1.glb`,
    `${releasePrefix}models/hands/improved/left-lod2.glb`,
    `${releasePrefix}models/hands/improved/right-lod2.glb`,
  ];
  for (const path of requiredReleasePaths) expect(offlinePaths.has(path), `offline manifest must include ${path}`).toBe(true);

  await page.goto("./?empty=true");
  await expect(page).toHaveTitle("PianoMotion Studio");
  await waitForLoadingToClear(page);
  await expect(page.locator("html")).toHaveAttribute("data-release-build-id", buildId);
  await expect(page.getByRole("button", { name: "Open preferences", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
  const modelSelect = preferences.locator("#settings-hand-model");
  await expect(modelSelect.locator("option")).toHaveCount(3);
  await modelSelect.selectOption("anatomical-improved");
  await expect.poll(async () => (await committedStudioSettings(page)).handModel).toBe("anatomical-improved");
  await preferences.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-release-build-id", buildId);
  await waitForLoadingToClear(page);
  await expect.poll(async () => (await committedStudioSettings(page)).handModel).toBe("anatomical-improved");
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Preferences", exact: true }).locator("#settings-hand-model"))
    .toHaveValue("anatomical-improved");
  await page.getByRole("dialog", { name: "Preferences", exact: true }).getByRole("button", { name: "Done", exact: true }).click();

  await page.locator("#midi-file").setInputFiles(fixturePath);
  await expectStudioCanvas(page);
  const settled = await settledStudio(page, 0);
  const threeDimensionalCanvas = page.getByTestId("piano-canvas-3d");
  await expect(threeDimensionalCanvas).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => {
    const hands = window.__playerSnapshot?.scene?.handModelDiagnostics;
    return hands ? [hands.left, hands.right].map(hand => ({
      requestedModel: hand.requestedModel,
      loadedModel: hand.loadedModel,
      state: hand.state,
      error: hand.error,
    })) : null;
  }), { timeout: 90_000, intervals: [250, 500, 1000] }).toEqual([
    { requestedModel: "anatomical-improved", loadedModel: "anatomical-improved", state: "ready", error: null },
    { requestedModel: "anatomical-improved", loadedModel: "anatomical-improved", state: "ready", error: null },
  ]);
  const productionHandDiagnostics = await page.evaluate(() => window.__playerSnapshot?.scene?.handModelDiagnostics ?? null);
  expect(productionHandDiagnostics).toBeTruthy();
  for (const hand of [productionHandDiagnostics!.left, productionHandDiagnostics!.right]) {
    expect(hand.loadedLod).toBeGreaterThanOrEqual(0);
    expect(hand.loadedLod).toBeLessThanOrEqual(2);
  }

  const modelManifestPath = `${releasePrefix}models/hands/improved/manifest.json`;
  const modelManifestResponse = await request.get(new URL(modelManifestPath, indexResponse.url()).href);
  expect(modelManifestResponse.status()).toBe(200);
  const modelManifest = await modelManifestResponse.json() as ImprovedHandManifest;
  expect(modelManifest.schemaVersion).toBe(1);
  expect(modelManifest.modelId).toBe("anatomical-improved");
  const modelManifestUrl = modelManifestResponse.url();
  const verifiedAssetUrls = new Map<string, string>();
  verifiedAssetUrls.set(relativeReleasePath(new URL(modelManifestUrl)), modelManifestUrl);
  for (const textureSet of Object.values(modelManifest.textures)) {
    for (const texturePath of [textureSet.baseColor, textureSet.normal, textureSet.roughness]) {
      const textureUrl = new URL(texturePath, modelManifestUrl);
      const releasePath = relativeReleasePath(textureUrl);
      expect(offlinePaths.has(releasePath), `offline manifest must include ${releasePath}`).toBe(true);
      verifiedAssetUrls.set(releasePath, textureUrl.href);
    }
  }
  for (const hand of ["left", "right"] as const) {
    expect(modelManifest.hands[hand].lods.map(lod => lod.level).sort()).toEqual([0, 1, 2]);
    for (const lod of modelManifest.hands[hand].lods) {
      const url = new URL(lod.url, modelManifestUrl);
      expect(url.pathname).toContain(`/releases/${buildId}/models/hands/improved/${hand}-lod${lod.level}.glb`);
      const response = await request.get(url.href);
      expect(response.status(), `${hand} LOD${lod.level} must be served from the release`).toBe(200);
      expect((await response.body()).byteLength).toBeGreaterThan(1024);
      verifiedAssetUrls.set(relativeReleasePath(url), url.href);
    }
  }
  const textureUrls = new Set(Object.values(modelManifest.textures).flatMap(texture => [
    texture.baseColor, texture.normal, texture.roughness,
  ]));
  expect(textureUrls.size).toBeGreaterThanOrEqual(3);
  for (const texture of textureUrls) {
    const url = new URL(texture, modelManifestUrl);
    expect(url.pathname).toContain(`/releases/${buildId}/models/hands/improved/`);
    expect((await request.get(url.href)).status(), `${url.pathname} must be served from the release`).toBe(200);
  }
  expect(textureUrls.size, "manifest should share the six expected texture resources across hands and LODs").toBe(6);
  expect(verifiedAssetUrls.size, "manifest, six GLBs, and six shared textures should be the 13 immutable assets").toBe(13);
  const offlineFilesByPath = new Map(offlineManifest.files.map(file => [file.path, file]));
  const verifiedAssetHashes: Array<{ path: string; sizeBytes: number; sha256: string }> = [];
  for (const [path, url] of verifiedAssetUrls) {
    const response = await request.get(url);
    expect(response.status(), `${path} must be available for offline hash verification`).toBe(200);
    const body = await response.body();
    const expected = offlineFilesByPath.get(path);
    expect(expected, `${path} must have an offline-manifest entry`).toBeTruthy();
    const sha256 = createHash("sha256").update(body).digest("hex");
    expect(body.byteLength, `${path} byte size must match the offline manifest`).toBe(expected!.sizeBytes);
    expect(sha256, `${path} SHA-256 must match the offline manifest`).toBe(expected!.sha256);
    verifiedAssetHashes.push({ path, sizeBytes: body.byteLength, sha256 });
  }

  const canvasPng = await threeDimensionalCanvas.screenshot({ path: testInfo.outputPath("anatomical-improved-production-visible-canvas.png") });
  const visibleSkinPixelCount = countVisibleSkinPixels(canvasPng);
  expect(visibleSkinPixelCount, "production canvas must visibly render improved hand surfaces").toBeGreaterThan(5_000);
  await testInfo.attach("anatomical-improved-production-visible-canvas", {
    path: testInfo.outputPath("anatomical-improved-production-visible-canvas.png"),
    contentType: "image/png",
  });

  await expect.poll(() => assetResponses.some(response =>
    response.url.includes(`/releases/${buildId}/models/hands/improved/manifest.json`)), { timeout: 30_000 })
    .toBe(true);
  expect(assetResponses.filter(response => response.status >= 400)).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(webglConsoleMessages, "production rendering must not report shader, vertex attribute, or WebGL errors").toEqual([]);
  await testInfo.attach("anatomical-improved-production-smoke", {
    contentType: "application/json",
    body: JSON.stringify({
      appBase,
      buildId,
      indexUrl: indexResponse.url(),
      scriptPath,
      webManifest: { name: webManifest.name, scope: webManifest.scope, startUrl: webManifest.start_url },
      offlineManifestFileCount: offlineManifest.files.length,
      modelManifestPath,
      modelId: modelManifest.modelId,
      projectId: settled.result.projectId,
      projectRevision: settled.result.revision,
      performancePlanId: settled.result.performancePlan?.planId ?? null,
      handModelDiagnostics: productionHandDiagnostics,
      handLods: Object.fromEntries(Object.entries(modelManifest.hands).map(([hand, value]) => [hand, value.lods.map(lod => lod.level)])),
      textureUris: [...textureUrls],
      verifiedAssetCount: verifiedAssetHashes.length,
      verifiedAssetHashes,
      visibleSkinPixelCount,
      persistedSettings: await committedStudioSettings(page),
      assetResponses,
      pageErrors,
      webglConsoleMessages,
      apiBoundary: "UI and versioned static release assets only; no /src imports",
    }, null, 2),
  });
});
