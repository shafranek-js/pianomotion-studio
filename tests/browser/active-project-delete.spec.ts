import { expect, test, type Page } from "@playwright/test";
import { loadStudioSong, waitForLoadingToClear } from "./studio-helpers";

async function recoveryProjectId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("handthesia_db");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const request = db.transaction("session", "readonly").objectStore("session").get("current_session");
        request.onsuccess = () => resolve(request.result?.projectId ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

test("deleting the active project also removes its recovery and survives reload", async ({ page }) => {
  test.setTimeout(240_000);
  await loadStudioSong(page);

  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save project", exact: true }).click();
  await expect(page.locator('.studio-save-state[data-kind="saved"]')).toBeVisible();

  const projectId = await page.evaluate(() => window.__playerSnapshot!.result.projectId);
  await expect.poll(() => recoveryProjectId(page)).toBe(projectId);

  await page.getByRole("button", { name: "Projects", exact: true }).click();
  const panel = page.getByTestId("projects-panel");
  const activeRow = panel.getByTestId("studio-project-row").filter({ has: page.locator('[aria-current="true"]') });
  page.once("dialog", dialog => void dialog.accept());
  await activeRow.getByRole("button", { name: /Delete project/ }).click();

  await expect.poll(() => recoveryProjectId(page)).toBeNull();
  // The player is still open; its blocked autosave must not recreate recovery.
  await page.waitForTimeout(1_000);
  expect(await recoveryProjectId(page)).toBeNull();

  await page.reload();
  await waitForLoadingToClear(page);
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeVisible({ timeout: 60_000 });
  expect(await recoveryProjectId(page)).toBeNull();
});
