import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expectStudioCanvas, loadStudioSong, settledStudio, waitForLoadingToClear } from "./studio-helpers";

function mixedMidi(): Buffer {
  const track = (program: number, pitch: number) => {
    // A sustained note leaves enough time to exercise real play/pause.
    const events = [0, 0xc0, program, 0, 0x90, pitch, 90, 0xbc, 0, 0x80, pitch, 0, 0, 0xff, 0x2f, 0];
    return [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, events.length, ...events];
  };
  return Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 1, 0xe0,
    ...track(0, 60), ...track(40, 67)]);
}

async function stableLayout(page: Page) {
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-layout-ready", "true");
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

test("compact transport fits desktop and touch viewports while preserving playback and backing controls", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const artifactDir = resolve("scratch/compact-transport-20261105");
  await mkdir(artifactDir, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await loadStudioSong(page, { output: "synth" });
  const transport = page.locator(".studio-transport-controls");
  await expect(page.getByTestId("transport-accompaniment-controls")).toHaveCount(0);
  await expect(transport.locator("#player-play-button")).toBeEnabled();

  await page.locator("#midi-file").setInputFiles({ name: "compact-piano-and-violin.mid", mimeType: "audio/midi", buffer: mixedMidi() });
  const guard = page.getByRole("alertdialog", { name: "Unsaved changes" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Discard and open", exact: true }).click();
  await waitForLoadingToClear(page);
  await expectStudioCanvas(page);
  await settledStudio(page, 0);
  const backing = transport.getByRole("button", { name: /^Accompaniment \(/ });
  await expect(backing).toBeVisible();
  await expect(backing).toHaveAttribute("aria-pressed", "true");

  const cdp = await page.context().newCDPSession(page);
  for (const { width, coarse } of [
    { width: 1920, coarse: false }, { width: 1280, coarse: false },
    { width: 1024, coarse: false }, { width: 1024, coarse: true }, { width: 390, coarse: false },
  ]) {
    const label = `${width}${coarse ? "-touch" : ""}`;
    await test.step(`${label}px layout`, async () => {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: coarse, maxTouchPoints: 1 });
      if (coarse) expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
      await stableLayout(page);
      const screenshot = resolve(artifactDir, `transport-${label}.png`);
      await page.screenshot({ path: screenshot });
      await testInfo.attach(`transport-${label}`, { path: screenshot, contentType: "image/png" });
      const layout = await transport.evaluate(element => {
        const rect = (node: Element) => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        const child = (selector: string) => {
          const node = element.querySelector(selector);
          if (!node) throw new Error(`Missing ${selector}`);
          return rect(node);
        };
        return {
          transport: rect(element), buttons: child(".studio-transport-controls__buttons"),
          seek: child(".studio-transport-controls__seek"), options: child(".studio-transport-controls__options"),
          controls: [...element.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button:not([role=slider]), input, select")]
            .map(node => ({ id: node.id, ...rect(node), title: node.title,
              label: node.getAttribute("aria-label"), visibleText: node instanceof HTMLButtonElement ? node.innerText.trim() : null })),
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: document.documentElement.scrollWidth,
        };
      });
      await testInfo.attach(`layout-${label}.json`, { body: JSON.stringify(layout, null, 2), contentType: "application/json" });
      const overlaps = (a: typeof layout.seek, b: typeof layout.seek) =>
        a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;
      expect.soft(overlaps(layout.buttons, layout.seek), `${width}: buttons overlap seek`).toBe(false);
      expect.soft(overlaps(layout.options, layout.seek), `${width}: options overlap seek`).toBe(false);
      expect.soft(overlaps(layout.options, layout.buttons), `${width}: options overlap buttons`).toBe(false);
      expect.soft(layout.documentWidth, `${width}: page horizontal overflow`).toBeLessThanOrEqual(width);
      expect.soft(layout.transport.bottom).toBeLessThanOrEqual(layout.viewport.height);
      if (width >= 1024 && !coarse) expect.soft(layout.transport.height, `${width}: desktop transport height`).toBeLessThanOrEqual(56);
      expect.soft(layout.seek.width, `${width}: usable timeline`).toBeGreaterThanOrEqual(width === 390 ? width * 0.8 : 140);
      for (const control of layout.controls) {
        expect.soft(control.x, `${width}: ${control.id} left edge`).toBeGreaterThanOrEqual(0);
        expect.soft(control.right, `${width}: ${control.id} right edge`).toBeLessThanOrEqual(width);
        expect.soft(control.y, `${width}: ${control.id} top edge`).toBeGreaterThanOrEqual(0);
        expect.soft(control.bottom, `${width}: ${control.id} bottom edge`).toBeLessThanOrEqual(layout.viewport.height);
        if (control.visibleText !== null) {
          expect.soft(control.label, `${width}: ${control.id} accessible name`).toBeTruthy();
          expect.soft(control.title, `${width}: ${control.id} hover description`).toBeTruthy();
          expect.soft(control.visibleText, `${width}: ${control.id} icon only`).toBe("");
        }
        if (width === 390 || coarse) {
          expect.soft(control.height, `${control.id} touch height`).toBeGreaterThanOrEqual(44);
          expect.soft(control.width, `${control.id} touch width`).toBeGreaterThanOrEqual(44);
        }
      }
    });
  }
  await cdp.detach();
  for (const toggle of await transport.locator("button[aria-pressed]").all()) {
    await expect(toggle).toHaveAttribute("aria-pressed", /^(true|false)$/);
  }

  // Operate the same loaded song on the narrowest screen.
  const backingVolume = transport.getByRole("slider", { name: "Accompaniment volume", exact: true });
  await backing.click();
  await expect(backing).toHaveAttribute("aria-pressed", "false");
  await expect(backingVolume).toBeDisabled();
  await backing.click();
  await expect(backingVolume).toBeEnabled();
  await backingVolume.fill("32");
  await expect(backingVolume).toHaveValue("32");
  await expect(backingVolume).toHaveAttribute("aria-valuetext", "32 percent");
  await transport.locator("#player-volume-slider").fill("0.45");
  await expect(transport.locator("#player-volume-slider")).toHaveValue("0.45");
  await transport.locator("#player-speed-select").selectOption("0.75");
  await expect(transport.locator("#player-speed-select")).toHaveValue("0.75");
  await transport.locator("#player-seek-slider").fill("1");
  await expect(transport.locator("#player-seek-slider")).toHaveValue("1");
  const play = transport.locator("#player-play-button");
  await play.click();
  await expect(play).toHaveAccessibleName("Pause");
  await expect(play).toHaveAttribute("title", "Pause");
  await expect.poll(async () => Number(await transport.locator("#player-seek-slider").inputValue())).toBeGreaterThan(1);
  await play.click();
  await expect(play).toHaveAccessibleName("Play");
  const pausedTime = Number(await transport.locator("#player-seek-slider").inputValue());
  await page.waitForTimeout(200);
  expect(Number(await transport.locator("#player-seek-slider").inputValue())).toBeCloseTo(pausedTime, 2);
});
