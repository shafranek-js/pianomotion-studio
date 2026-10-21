import { expect, test } from "@playwright/test";
import { expectStudioCanvas, saveStudioProject } from "./studio-helpers";

test("an unvisited built-in melody opens offline from a coherent production release", async ({ page, context }) => {
  const previewBase = process.env.PIANOMOTION_PREVIEW_BASE ?? "/";
  await page.goto(previewBase.includes("?") ? `${previewBase}&empty=true` : `${previewBase}?empty=true`);
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 45_000 }).toBe(true);
  await page.getByTestId("studio-welcome").getByRole("button", { name: "Browse built-in melodies", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Built-in melodies", exact: true });
  await dialog.getByRole("searchbox", { name: "Search melodies" }).fill("Brahms");
  await dialog.getByRole("button", { name: "Open Brahms' Lullaby", exact: true }).click();
  await expectStudioCanvas(page, 90_000);
  const originalId = await page.evaluate(() => window.__playerSnapshot!.result.projectId);
  await saveStudioProject(page);
  await page.close();
  await context.setOffline(true);
  const reopened = await context.newPage();
  try {
    await reopened.goto(process.env.PIANOMOTION_PREVIEW_BASE ?? "/");
    await expectStudioCanvas(reopened, 90_000);
    await reopened.getByRole("button", { name: "File", exact: true }).click();
    await reopened.getByRole("menuitem", { name: "Built-in melodies…", exact: true }).click();
    const offlineDialog = reopened.getByRole("dialog", { name: "Built-in melodies", exact: true });
    // The previous search is persisted as a library preference, so clear it
    // before asserting that the whole offline catalogue is available.
    await offlineDialog.getByRole("searchbox", { name: "Search melodies" }).fill("");
    await expect(offlineDialog.getByRole("list").getByRole("listitem")).toHaveCount(163);
    await offlineDialog.getByRole("searchbox", { name: "Search melodies" }).fill("A Tisket");
    await offlineDialog.getByRole("button", { name: "Open A Tisket, A Tasket", exact: true }).click();
    await expect.poll(() => reopened.evaluate(oldId => {
      const nextId = window.__playerSnapshot?.result.projectId;
      return Boolean(nextId && nextId !== oldId);
    }, originalId), { timeout: 90_000 }).toBe(true);
    await expect(reopened.getByText("A Tisket, A Tasket", { exact: true })).toBeVisible();
    expect(await reopened.evaluate(() => window.__playerSnapshot!.scene!.keyCount)).toBe(88);
    await reopened.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => reopened.getByRole("slider", { name: "Seek position" }).inputValue().then(Number), { timeout: 15_000 }).toBeGreaterThan(0);
    await reopened.getByRole("button", { name: "Pause", exact: true }).click();
  } finally { await context.setOffline(false); }
});
