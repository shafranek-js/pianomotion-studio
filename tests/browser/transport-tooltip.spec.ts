import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadStudioSong, studioCanvas } from "./studio-helpers";

const artifactDir = resolve("scratch/transport-tooltip-20261105");

async function settleLayout(page: Page) {
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-layout-ready", "true");
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function verifyPopup(page: Page, handle: Locator, label: string, testInfo: TestInfo) {
  const popup = page.locator(".studio-transport-controls__loop-tooltip");
  await expect(popup).toBeVisible();
  await settleLayout(page);
  // Four full-app hover captures cover both endpoints and viewport boundaries.
  // Focus, drag and resize reuse the same paint/geometry checks below.
  if (label.includes("-hover-")) {
    const screenshot = resolve(artifactDir, `${label}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(label, { path: screenshot, contentType: "image/png" });
  }
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("Loop handle has no bounds");
  const metrics = await popup.evaluate(element => {
    const box = element.getBoundingClientRect();
    const track = document.querySelector(".studio-transport-controls__seek-track")!.getBoundingClientRect();
    const controls = document.querySelector(".studio-transport-controls")!.getBoundingClientRect();
    const transport = document.querySelector(".studio-transport")!;
    const boundary = transport.getBoundingClientRect();
    // Tooltips intentionally ignore pointers. Temporarily enable hit testing without
    // changing layout; clipped or covered pixels still cannot hit the tooltip.
    const node = element as HTMLElement;
    const original = node.style.pointerEvents;
    node.style.pointerEvents = "auto";
    const hits = [
      [box.left + 2, box.top + 2], [box.right - 2, box.top + 2],
      [box.left + 2, box.bottom - 2], [box.right - 2, box.bottom - 2],
      [box.left + box.width / 2, box.top + box.height / 2],
    ].map(([x, y]) => element.contains(document.elementFromPoint(x, y)));
    node.style.pointerEvents = original;
    return {
      popup: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height },
      trackTop: track.top, controlsTop: controls.top, controlsHeight: controls.height,
      clippingBoundaryTop: boundary.top, overflow: getComputedStyle(transport).overflowY,
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth, hits,
      text: element.textContent,
    };
  });
  await writeFile(resolve(artifactDir, `${label}.json`), JSON.stringify(metrics, null, 2));
  expect(metrics.popup.width).toBeGreaterThan(40);
  expect(metrics.popup.height).toBeGreaterThan(10);
  expect(metrics.popup.left).toBeGreaterThanOrEqual(8);
  expect(metrics.popup.right).toBeLessThanOrEqual(metrics.viewport.width - 8);
  expect(metrics.popup.top).toBeGreaterThanOrEqual(8);
  expect(metrics.popup.bottom).toBeLessThanOrEqual(metrics.viewport.height - 8);
  expect(metrics.popup.bottom).toBeLessThanOrEqual(handleBox.y + 1);
  expect(metrics.popup.top).toBeLessThan(metrics.trackTop);
  expect(metrics.hits, "all tooltip corners and center must paint above clipping ancestors").toEqual([true, true, true, true, true]);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport.width);
  const expectedCenter = Math.max(8 + metrics.popup.width / 2, Math.min(metrics.viewport.width - 8 - metrics.popup.width / 2, handleBox.x + handleBox.width / 2));
  expect(Math.abs((metrics.popup.left + metrics.popup.right) / 2 - expectedCenter), "popup remains anchored after layout changes").toBeLessThanOrEqual(2);
  if (metrics.viewport.width >= 1000) {
    expect(metrics.controlsHeight).toBeLessThanOrEqual(56);
    expect(metrics.popup.top, "desktop popup escapes the compact transport boundary").toBeLessThan(metrics.clippingBoundaryTop);
  }
  return metrics;
}

test("compact loop tooltips stay visible on hover, keyboard focus, resize, and drag", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await mkdir(artifactDir, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await loadStudioSong(page, { output: "synth" });
  const transport = page.locator(".studio-transport-controls--compact");
  const start = transport.getByRole("slider", { name: "Loop start (A)", exact: true });
  const end = transport.getByRole("slider", { name: "Loop end (B)", exact: true });
  await expect(start).toBeEnabled();
  await expect(end).toBeEnabled();

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await settleLayout(page);
    // Home/End put endpoints at their real timeline edges, including the narrow viewport.
    await start.focus();
    await start.press("Home");
    await end.focus();
    await end.press("End");
    await end.evaluate(element => (element as HTMLElement).blur());
    const height = (await transport.boundingBox())!.height;
    for (const [letter, handle] of [["A", start], ["B", end]] as const) {
      await handle.hover();
      const metrics = await verifyPopup(page, handle, `${width}-hover-${letter}`, testInfo);
      expect(metrics.text).toMatch(new RegExp(`^${letter} · `));
      expect(metrics.controlsHeight).toBeCloseTo(height, 1);
      if (width === 1280 && letter === "A") {
        // The first capture proves the default 3D app. Keep the same transport
        // mounted while avoiding software WebGL cost for the remaining probes.
        await page.getByRole("button", { name: "2D", exact: true }).click();
        await expect(studioCanvas(page, "2d")).toBeVisible();
      }
    }
    await page.mouse.move(1, 1);
    if (width === 1280) {
      // Follow the actual keyboard tab order rather than synthesizing a focus event.
      await start.focus();
      await start.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(start).toBeFocused();
      await verifyPopup(page, start, `${width}-focus-A`, testInfo);
      await page.keyboard.press("Tab");
      await expect(end).toBeFocused();
      await verifyPopup(page, end, `${width}-focus-B`, testInfo);
    }
    // The narrower touch-sized controls also exercise endpoint dragging.
    for (const [letter, handle, direction] of width === 390 ? [["A", start, 1], ["B", end, -1]] as const : []) {
      const initial = Number(await handle.getAttribute("aria-valuenow"));
      const box = (await handle.boundingBox())!;
      const track = (await transport.locator(".studio-transport-controls__seek-track").boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + direction * track.width * 0.2, box.y + box.height / 2, { steps: 8 });
      const metrics = await verifyPopup(page, handle, `${width}-drag-${letter}`, testInfo);
      await page.mouse.up();
      const updated = Number(await handle.getAttribute("aria-valuenow"));
      expect(direction * (updated - initial), `${letter} drag changes its loop endpoint`).toBeGreaterThan(0);
      expect(metrics.controlsHeight).toBeCloseTo(height, 1);
      await expect(handle).toHaveAttribute("aria-valuetext", new RegExp(`^${letter}: `));
    }
  }
  // Keep focus while resizing so the open portal must follow the new timeline bounds.
  await page.mouse.move(1, 1);
  await start.focus();
  await page.setViewportSize({ width: 1280, height: 900 });
  await settleLayout(page);
  await verifyPopup(page, start, "1280-resized-focus-A", testInfo);
  await page.evaluate(() => window.scrollBy(0, 120));
  await verifyPopup(page, start, "1280-scroll-focus-A", testInfo);
});
