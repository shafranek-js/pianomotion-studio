import { expect, test } from "@playwright/test";
import { configureStudioTestOutput, expectStudioCanvas } from "./studio-helpers";

test("Play along mode activates, provides step-by-step chord practice, and handles hand filtering and navigation", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");

  await expect(page).toHaveTitle("PianoMotion Studio");
  await expectStudioCanvas(page, 60_000);
  await expect(page.getByTestId("studio-header").getByText("Гімн України")).toBeVisible();
  await configureStudioTestOutput(page);
  await page.getByRole("button", { name: "Performance", exact: true }).click();

  // 1. Switch to "Play along" mode
  const playAlongButton = page.getByRole("button", { name: "Play along", exact: true });
  await expect(playAlongButton).toBeVisible();
  await playAlongButton.click();

  // 2. Verify practice control bar is rendered
  const practiceControls = page.getByLabel("Play along practice controls");
  await expect(practiceControls).toBeVisible();
  await expect(practiceControls.getByText(/Step 1 of \d+/)).toBeVisible();

  // 3. Step forward and backward
  const nextButton = practiceControls.getByRole("button", { name: "Next step" });
  await nextButton.click();
  await expect(practiceControls.getByText(/Step 2 of \d+/)).toBeVisible();

  const prevButton = practiceControls.getByRole("button", { name: "Previous step" });
  await prevButton.click();
  await expect(practiceControls.getByText(/Step 1 of \d+/)).toBeVisible();

  // 4. Toggle hand mode
  const rhOnlyButton = practiceControls.getByRole("button", { name: "Right hand" });
  await rhOnlyButton.click();
  // Ensure Auto-play other hand checkbox appears when a single hand is chosen
  await expect(practiceControls.getByLabel("Auto-play other hand")).toBeVisible();

  // 5. Test restart from beginning
  await nextButton.click();
  await expect(practiceControls.getByText(/Step 2 of \d+/)).toBeVisible();
  const restartButton = practiceControls.getByRole("button", { name: "Restart from beginning" });
  await restartButton.click();
  await expect(practiceControls.getByText(/Step 1 of \d+/)).toBeVisible();

  // 6. Test computer keyboard navigation (ArrowRight and ArrowLeft)
  // Shortcut navigation is scoped to the workspace so focused controls keep
  // their native keyboard behavior.
  const workspaceCanvas = page.getByLabel("Piano workspace");
  await expect(workspaceCanvas).toBeVisible();
  await workspaceCanvas.focus();
  await page.keyboard.press("ArrowRight");
  await expect(practiceControls.getByText(/Step 2 of \d+/)).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(practiceControls.getByText(/Step 1 of \d+/)).toBeVisible();

  // 7. Verify switching back to Performance mode restores standard transport
  await page.getByRole("button", { name: "Performance", exact: true }).click();
  await expect(practiceControls).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  expect(pageErrors).toEqual([]);
});
