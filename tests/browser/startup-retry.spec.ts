import { expect, test } from "@playwright/test";

test("startup failure can be retried without reloading the page", async ({ page }) => {
  let failManifest = true;
  let manifestRequests = 0;
  await page.route(/\/python-core\/source_manifest\.json(?:\?|$)/, async (route) => {
    manifestRequests += 1;
    if (failManifest) await route.abort("failed");
    else await route.continue();
  });

  await page.goto("/?empty=true", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 30_000 });
  failManifest = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();

  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 60_000 });
  expect(manifestRequests).toBeGreaterThanOrEqual(2);
});
