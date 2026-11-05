import { expect, test } from "@playwright/test";
import { configureStudioTestOutput, expectStudioCanvas, openStudioInspector, settledStudio, waitForLoadingToClear } from "./studio-helpers";

function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  for (value >>>= 7; value > 0; value >>>= 7) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

function trackChunk(events: number[]): number[] {
  return [0x4d, 0x54, 0x72, 0x6b, (events.length >>> 24) & 255, (events.length >>> 16) & 255,
    (events.length >>> 8) & 255, events.length & 255, ...events];
}

function instrumentTrack(name: string, program: number, pitch: number): number[] {
  const nameBytes = [...new TextEncoder().encode(name)];
  return [0, 0xff, 0x03, nameBytes.length, ...nameBytes, 0, 0xc0, program,
    0, 0x90, pitch, 90, ...vlq(480), 0x80, pitch, 0, 0, 0xff, 0x2f, 0];
}

function makeMidi(mixed: boolean): Uint8Array {
  const tracks = [trackChunk(instrumentTrack("Piano", 0, 60))];
  if (mixed) tracks.push(trackChunk(instrumentTrack("Violin", 40, 67)));
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, 1, 0xe0, ...tracks.flat()]);
}

test("accompaniment controls follow the loaded file and stay synchronized in Audio inspector", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("/?empty=true");
  await waitForLoadingToClear(page);
  await configureStudioTestOutput(page);

  await page.locator("#midi-file").setInputFiles({ name: "piano-and-violin.mid", mimeType: "audio/midi", buffer: Buffer.from(makeMidi(true)) });
  try {
    await expectStudioCanvas(page, 60_000);
  } catch (error) {
    const state = await page.locator("body").innerText().catch(() => "<page unavailable>");
    throw new Error(`Mixed-score load did not produce a canvas. pageErrors=${JSON.stringify(pageErrors)} body=${state.slice(0, 3000)}`, { cause: error });
  }
  await settledStudio(page, 0);
  const controls = page.getByTestId("transport-accompaniment-controls");
  const transportToggle = page.getByRole("button", { name: "Accompaniment (Violin)" });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: testInfo.outputPath("accompaniment-controls-desktop.png") });
  await expect(transportToggle).toBeVisible();
  await expect(transportToggle).toHaveAttribute("aria-pressed", "true");
  const transportVolume = controls.getByRole("slider", { name: "Accompaniment volume" });
  await expect(transportVolume).toBeVisible();
  await expect(transportVolume).toHaveValue("65");
  const desktopLayout = await page.locator(".studio-transport-controls.has-accompaniment").evaluate(element => {
    const bounds = (selector: string) => {
      const child = element.querySelector(selector);
      if (!child) throw new Error(`Missing transport layout element: ${selector}`);
      const rect = child.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const transport = element.getBoundingClientRect();
    const statusbar = document.querySelector(".studio-statusbar")?.getBoundingClientRect();
    if (!statusbar) throw new Error("Missing studio statusbar");
    return {
      transport: { x: transport.x, y: transport.y, right: transport.right, bottom: transport.bottom, width: transport.width, height: transport.height },
      buttons: bounds(".studio-transport-controls__buttons"),
      seek: bounds(".studio-transport-controls__seek"),
      options: bounds(".studio-transport-controls__options"),
      statusbar: { x: statusbar.x, y: statusbar.y, right: statusbar.right, bottom: statusbar.bottom, width: statusbar.width, height: statusbar.height },
      viewportHeight: window.innerHeight,
    };
  });
  await testInfo.attach("desktop-transport-layout.json", { body: JSON.stringify(desktopLayout, null, 2), contentType: "application/json" });
  const overlaps = (["buttons", "seek"] as const).filter(name => {
    const a = desktopLayout.options;
    const b = desktopLayout[name];
    return a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
  });
  expect(overlaps, `Accompaniment options overlap transport regions: ${JSON.stringify(desktopLayout)}`).toEqual([]);
  expect(desktopLayout.statusbar.y).toBeGreaterThanOrEqual(0);
  expect(desktopLayout.statusbar.bottom).toBeLessThanOrEqual(desktopLayout.viewportHeight);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const compactLayout = await controls.evaluate(element => {
    const ancestors: Array<Record<string, unknown>> = [];
    let current: Element | null = element;
    while (current && ancestors.length < 6) {
      const rect = current.getBoundingClientRect();
      const style = getComputedStyle(current);
      ancestors.push({
        tag: current.tagName,
        className: current.className,
        display: style.display,
        position: style.position,
        overflow: style.overflow,
        maxHeight: style.maxHeight,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
      current = current.parentElement;
    }
    return { viewport: { width: innerWidth, height: innerHeight }, ancestors };
  });
  await testInfo.attach("compact-transport-layout.json", { body: JSON.stringify(compactLayout, null, 2), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("accompaniment-controls-compact.png") });
  await expect(transportToggle).toBeVisible();
  await expect(transportToggle).toBeInViewport({ ratio: 1 });
  await expect(transportVolume).toBeVisible();
  await expect(transportVolume).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 1280, height: 900 });

  await openStudioInspector(page, "Audio");
  await expect(page.getByText("Violin · 1 notes", { exact: true })).toBeVisible();
  const inspectorToggle = page.locator("#studio-accompaniment-enabled");
  await expect(inspectorToggle).toBeChecked();
  await inspectorToggle.uncheck();
  await expect(transportToggle).toHaveAttribute("aria-pressed", "false");
  const inspectorVolume = page.getByTestId("inspector-panel").getByRole("slider", { name: "Accompaniment volume" });
  await expect(inspectorVolume).toHaveValue("65");
  await inspectorToggle.check();
  await inspectorVolume.fill("32");
  await expect(transportVolume).toHaveValue("32");
  await expect(transportToggle).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: /^Play along$/i }).click();
  await expect(controls).toHaveCount(0);
  await openStudioInspector(page, "Audio");
  await expect(page.getByRole("region", { name: "Multi-Instrument Accompaniment" })).toHaveCount(0);
  const pianoOnlyPitches = await page.evaluate(() =>
    (window as Window & { __playerSnapshot?: { result: { document?: { notes: Array<{ pitch: number }> } } } })
      .__playerSnapshot?.result.document?.notes.map(note => note.pitch) ?? [],
  );
  expect(pianoOnlyPitches).toEqual([60]);
  await page.getByRole("button", { name: /^Performance/ }).click();
  await expect(transportToggle).toBeVisible();

  await page.locator("#midi-file").setInputFiles({ name: "solo-piano.mid", mimeType: "audio/midi", buffer: Buffer.from(makeMidi(false)) });
  const unsavedChanges = page.getByRole("alertdialog", { name: "Unsaved changes" });
  await expect(unsavedChanges).toBeVisible();
  await unsavedChanges.getByRole("button", { name: "Discard and open" }).click();
  await waitForLoadingToClear(page);
  try {
    await expectStudioCanvas(page, 60_000);
  } catch (error) {
    const state = await page.locator("body").innerText().catch(() => "<page unavailable>");
    throw new Error(`Solo-score load did not produce a canvas. pageErrors=${JSON.stringify(pageErrors)} body=${state.slice(0, 3000)}`, { cause: error });
  }
  await settledStudio(page, 0);
  await expect(page.getByText("solo-piano.mid", { exact: true })).toBeVisible();
  await expect(controls).toHaveCount(0);
  await openStudioInspector(page, "Audio");
  await expect(page.getByRole("region", { name: "Multi-Instrument Accompaniment" })).toHaveCount(0);
});
