import { expect, test } from "@playwright/test";

test("shows the honest browser bootstrap state", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");

  await expect(page).toHaveTitle("PianoMotion Studio · MIDI diagnostics");
  await expect(
    page.getByRole("heading", { level: 1, name: "MIDI analysis diagnostics" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Pyodide stays idle until you start an analysis.",
  );
  expect(pageErrors).toEqual([]);
});
