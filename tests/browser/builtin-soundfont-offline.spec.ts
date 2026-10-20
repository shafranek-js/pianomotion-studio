import { expect, test } from "@playwright/test";
import { expectStudioCanvas, loadStudioSong, openStudioInspector, saveStudioProject } from "./studio-helpers";

test("included SF3 and decoder restore and play offline without a user bank", async ({page, context}, testInfo) => {
  test.setTimeout(240_000);
  await context.addInitScript(() => {
    const state = window as Window & {__sampleStarts?:number};
    state.__sampleStarts = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args:[number?, number?, number?]) {
      if (this.buffer && this.buffer.length > 1000) state.__sampleStarts!++;
      return Reflect.apply(start, this, args);
    };
  });
  const savedStudio = await loadStudioSong(page, { output: "soundfont" });
  const savedNoteCount = savedStudio.result.document?.notes.length ?? 0;
  expect(savedNoteCount).toBeGreaterThan(0);
  await openStudioInspector(page, "Audio");
  await expect(page.getByText("Active output: MuseScore General v0.2", {exact:true})).toBeVisible({timeout:120_000});
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), {timeout:90_000}).toBe(true);
  await saveStudioProject(page);
  await page.close();
  await context.setOffline(true);
  const restored = await context.newPage();
  try {
    await restored.goto(process.env.PIANOMOTION_PREVIEW_BASE ?? "/");
    await expectStudioCanvas(restored, 90_000);
    await openStudioInspector(restored, "Audio");
    await expect(restored.getByText("Active output: MuseScore General v0.2", {exact:true})).toBeVisible({timeout:120_000});
    await expect.poll(() => restored.evaluate(() => window.__playerSnapshot?.result.document?.notes.length ?? 0), {timeout:30_000})
      .toBe(savedNoteCount);
    await restored.getByRole("button", {name:"Play", exact:true}).click();
    await expect.poll(() => restored.evaluate(() => (window as Window & {__sampleStarts?:number}).__sampleStarts ?? 0), {timeout:30_000}).toBeGreaterThan(0);
    await expect.poll(async () => Number(await restored.locator("#player-seek-slider").inputValue()), {timeout:30_000}).toBeGreaterThan(0.25);
    await restored.getByRole("button", {name:"Pause", exact:true}).click();
    await testInfo.attach("builtin-sf3-offline", {contentType:"application/json", body:JSON.stringify({base:process.env.PIANOMOTION_PREVIEW_BASE ?? "/", sampleStarts:await restored.evaluate(() => (window as Window & {__sampleStarts?:number}).__sampleStarts), keys:await restored.evaluate(() => window.__playerSnapshot?.scene?.keyCount)})});
  } finally { await context.setOffline(false); }
});
