import { expect, test } from "@playwright/test";

test("playback keeps a reserve with delayed real Worker motion and honors Pause after an uncovered seek", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      const args = options === undefined ? [message] : [message, options];
      if ((message as { type?: string })?.type === "sample-motion") {
        setTimeout(() => Reflect.apply(original, this, args), 1500);
        return;
      }
      return Reflect.apply(original, this, args);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Play demo song", exact: true }).click();
  const canvas = page.locator("#piano-canvas-container canvas");
  await expect(canvas).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(() => window.__playerSnapshot?.scene?.keyCount === 88 && !window.__playerSnapshot.pending);
  await page.locator("#player-play-button").click();
  // Transport exposes current time through the accessible seek control; unlike
  // wall-clock sleeps, this verifies that the musical clock actually advanced.
  await expect.poll(() => page.getByRole("slider", { name: "Seek position", exact: true }).inputValue().then(Number),
    { timeout: 55_000, intervals: [500] }).toBeGreaterThan(25);
  const running = await page.evaluate(() => window.__playerSnapshot!.motionStreaming!);
  expect(running.requestCount).toBeGreaterThan(3);
  expect(running.pauseCount).toBe(0);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  await page.getByRole("slider", { name: "Seek position", exact: true }).evaluate(element => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, "37");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => window.__playerSnapshot!.motionStreaming?.buffering), { timeout: 5000 }).toBe(true);
  await page.locator("#player-play-button").click();
  const stoppedAt = Number(await page.getByRole("slider", { name: "Seek position", exact: true }).inputValue());
  await page.waitForTimeout(3500);
  expect(Number(await page.getByRole("slider", { name: "Seek position", exact: true }).inputValue())).toBeCloseTo(stoppedAt, 1);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await testInfo.attach("motion-playback-reserve", { contentType: "application/json", body: JSON.stringify({ running, stoppedAt, errors }, null, 2) });
});

test("real Worker keeps the animation reserve during double-speed playback", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Play demo song", exact: true }).click();
  await expect(page.locator("#piano-canvas-container canvas")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("combobox", { name: "Speed", exact: true }).selectOption("2");
  await page.locator("#player-play-button").click();
  await expect.poll(() => page.getByRole("slider", { name: "Seek position", exact: true }).inputValue().then(Number),
    { timeout: 45_000, intervals: [500] }).toBeGreaterThan(25);
  const streaming = await page.evaluate(() => window.__playerSnapshot!.motionStreaming!);
  await testInfo.attach("motion-double-speed", { contentType: "application/json", body: JSON.stringify({ streaming, errors }, null, 2) });
  expect(streaming.pauseCount).toBe(0);
  expect(streaming.requestCount).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Seek position", exact: true })).toHaveValue("-2");
  expect(errors).toEqual([]);
});
