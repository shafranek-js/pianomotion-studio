import { expect, test } from "@playwright/test";
import { loadStudioSong } from "./studio-helpers";

test("returns focus to the rename button after cancelling a bookmark rename", async ({ page }) => {
  await loadStudioSong(page);
  await page.getByRole("button", { name: "Practice", exact: true }).click();

  const name = `Focus ${Date.now()}`;
  await page.getByLabel("Bookmark name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add bookmark", exact: true }).click();

  const renameButton = page.getByRole("button", { name: `Rename bookmark: ${name}`, exact: true });
  await renameButton.click();
  const input = page.getByLabel("Rename bookmark", { exact: true });
  await expect(input).toBeFocused();

  await input.press("Escape");
  await expect(renameButton).toBeFocused();
});
