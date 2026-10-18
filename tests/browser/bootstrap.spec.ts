import { expect, test } from "@playwright/test";
import { expectStudioCanvas } from "./studio-helpers";

test("shows the honest browser bootstrap state with default anthem melody", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");

  await expect(page).toHaveTitle("PianoMotion Studio");
  await expect(page.getByTestId("studio-shell")).toBeVisible();
  await expect(page.getByTestId("studio-status")).toBeVisible();
  await expectStudioCanvas(page, 60_000);
  await expect(page.getByTestId("studio-header").getByText("Гімн України")).toBeVisible();
  await expect(page.getByRole("heading", {name: "MIDI analysis diagnostics"})).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("shows empty workspace when requested via ?empty", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/?empty=true");

  await expect(page).toHaveTitle("PianoMotion Studio");
  await expect(page.getByTestId("studio-shell")).toBeVisible();
  await expect(page.getByRole("button", {name: "Open MIDI", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Open Project", exact: true})).toBeVisible();
  await expect(page.getByTestId("piano-canvas").locator("canvas")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
