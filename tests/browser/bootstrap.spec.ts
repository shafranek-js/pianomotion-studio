import { expect, test } from "@playwright/test";

test("shows the honest browser bootstrap state", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");

  await expect(page).toHaveTitle("PianoMotion Studio");
  await expect(page.getByTestId("studio-shell")).toBeVisible();
  await expect(page.getByRole("button", {name: "Open MIDI", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Open Project", exact: true})).toBeVisible();
  await expect(page.getByTestId("studio-status")).toBeVisible();
  await expect(page.locator("#piano-canvas-container canvas")).toHaveCount(0);
  await expect(page.getByRole("heading", {name: "MIDI analysis diagnostics"})).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
