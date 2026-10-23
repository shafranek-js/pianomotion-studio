import { expect, test, type Page } from "@playwright/test";
import { loadStudioSong } from "./studio-helpers";

async function installContextControl(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((canvasSelector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(canvasSelector);
    const gl = (canvas?.getContext("webgl2") ?? canvas?.getContext("webgl")) as WebGLRenderingContext | null;
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    (window as Window & { __loseGraphics?: () => void; __restoreGraphics?: () => void }).__loseGraphics = () => extension.loseContext();
    (window as Window & { __loseGraphics?: () => void; __restoreGraphics?: () => void }).__restoreGraphics = () => extension.restoreContext();
    return true;
  }, selector);
}

async function loseAndRestore(page: Page, selector: string): Promise<void> {
  const available = await installContextControl(page, selector);
  test.skip(!available, `WEBGL_lose_context is unavailable for ${selector}`);

  await page.evaluate(() => (window as Window & { __loseGraphics?: () => void }).__loseGraphics?.());
  await expect(page.getByTestId("studio-status")).toContainText(/Graphics context was lost/, { timeout: 15_000 });

  await page.evaluate(() => (window as Window & { __restoreGraphics?: () => void }).__restoreGraphics?.());
  await expect(page.getByTestId("studio-status")).toContainText(/Graphics context restored/, { timeout: 15_000 });
}

test("Pixi 2D canvas loss and restore are reported", async ({ page }) => {
  test.setTimeout(180_000);
  await loadStudioSong(page);
  const canvas = page.locator('#piano-canvas-container canvas[aria-label="Piano workspace"]').first();
  await expect(canvas).toHaveCount(1);

  await loseAndRestore(page, '#piano-canvas-container canvas[aria-label="Piano workspace"]');
  await expect(canvas).toHaveCount(1);
});

test("visible Three.js 3D canvas loss and restore are reported", async ({ page }) => {
  test.setTimeout(180_000);
  await loadStudioSong(page);
  const canvas = page.getByTestId("piano-canvas-3d");
  await expect(canvas).toBeVisible({ timeout: 60_000 });

  await loseAndRestore(page, '[data-testid="piano-canvas-3d"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate(element => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  expect(size.width).toBeGreaterThan(0);
  expect(size.height).toBeGreaterThan(0);
});
