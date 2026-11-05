import { expect, test, type Locator, type Page } from "@playwright/test";
import { configureStudioTestOutput, expectStudioCanvas, settledStudio, studioCanvas, studioMidiPath } from "./studio-helpers";

async function hitTestRailButton(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  await button.click({ trial: true });
}

async function expectNoDocumentHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("workspace rail opens real tools and stays usable from empty desktop through narrow mobile", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  const analysisWorkers: string[] = [];
  page.on("worker", (worker) => {
    const url = worker.url();
    if (url.includes("midi-analysis-ts.worker") || url.includes("midi-analysis.worker")) analysisWorkers.push(url);
  });

  await page.goto("/?empty=true");
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-layout-ready", "true");
  const rail = page.getByTestId("studio-tool-rail");
  await expect(rail).toBeVisible();

  await expect(rail.getByRole("button", { name: "Open audio recording settings", exact: true })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "Open melody file...", exact: true })).toHaveCount(0);
  const inspectorButton = rail.getByRole("button", { name: "Inspector", exact: true });
  await expect(rail.getByRole("button", { name: "Practice", exact: true })).toBeDisabled();
  await inspectorButton.click();
  await page.getByRole("tab", { name: "Audio", exact: true }).click();
  await expect(page.getByTestId("inspector-panel")).toContainText("Open a MIDI project to edit its studio settings.");
  await expect(page.locator("#audio-track-file-input")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Scope this entry point to the rail: the empty-state welcome page has a
  // second Browse button with the same accessible name.
  const libraryButton = rail.getByRole("button", { name: "Browse melody library", exact: true });
  await libraryButton.click();
  const libraryDialog = page.getByRole("dialog", { name: "Melody library", exact: true });
  await expect(libraryDialog).toBeVisible();
  await expect(libraryDialog.getByRole("list").getByRole("listitem").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(libraryDialog).toBeHidden();
  await expect(libraryButton).toBeFocused();

  // Exercise a translated rail label through the actual Preferences surface,
  // then restore English for the rest of this regression scenario.
  const preferencesButton = rail.locator(".studio-rail-preferences-button");
  await preferencesButton.click();
  const preferencesDialog = page.getByRole("dialog").filter({ has: page.locator("#settings-language") });
  await expect(preferencesDialog).toBeVisible();
  const language = preferencesDialog.locator("#settings-language");
  await language.selectOption("de");
  await page.keyboard.press("Escape");
  await expect(preferencesDialog).toBeHidden();
  await expect(preferencesButton).toBeFocused();
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute("aria-label", "Werkzeuge für den Arbeitsbereich");
  await expect(rail.getByRole("button", { name: "Audioaufnahme-Einstellungen öffnen", exact: true })).toHaveCount(0);

  await preferencesButton.click();
  await expect(preferencesDialog).toBeVisible();
  await language.selectOption("en");
  await page.keyboard.press("Escape");
  await expect(preferencesDialog).toBeHidden();
  await expect(preferencesButton).toBeFocused();
  await expect(rail).toHaveAttribute("aria-label", "Workspace tools");

  await configureStudioTestOutput(page);
  await page.getByRole("button", { name: "File", exact: true }).click();
  const importMidiButton = page.getByRole("menuitem", { name: "Open melody file...", exact: true });
  const chooserPromise = page.waitForEvent("filechooser");
  await importMidiButton.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(studioMidiPath);

  // The file chooser feeds the normal import path and the real analysis
  // Worker. A rendered scene alone is not enough to call this import ready.
  await expectStudioCanvas(page, 180_000);
  const snapshot = await settledStudio(page, 0);
  expect(snapshot.result.document!.notes.length).toBeGreaterThan(0);
  expect(analysisWorkers).toHaveLength(1);

  await expect(rail.getByRole("button", { name: "Practice", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Performance", exact: true }).click();
  await expect(studioCanvas(page, "3d")).toBeVisible();
  const desktopPath = testInfo.outputPath("rail-desktop.png");
  await page.screenshot({ path: desktopPath });
  await testInfo.attach("rail-desktop", { path: desktopPath, contentType: "image/png" });

  // Audio remains reachable through Inspector, including its real import control.
  await inspectorButton.click();
  const inspectorPanel = page.getByTestId("inspector-panel");
  await expect(inspectorPanel).toBeVisible();
  await expect(inspectorPanel.getByRole("tab", { name: "Audio", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(inspectorPanel.locator("#audio-track-file-input")).toBeEnabled();
  const sceneTab = inspectorPanel.getByRole("tab", { name: "Scene", exact: true });
  await sceneTab.click();
  await expect(sceneTab).toHaveAttribute("aria-selected", "true");
  await inspectorPanel.getByRole("tab", { name: "Audio", exact: true }).click();
  await expect(inspectorPanel.getByRole("tab", { name: "Audio", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(inspectorPanel).toBeHidden();
  await expect(inspectorButton).toBeFocused();

  await page.setViewportSize({ width: 1024, height: 350 });
  const workspace = page.getByTestId("studio-workspace");
  await workspace.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const shortDesktopButtons = [
    rail.getByRole("button", { name: "Browse melody library", exact: true }),
    rail.getByRole("button", { name: "Projects", exact: true }),
    rail.getByRole("button", { name: "Inspector", exact: true }),
    rail.getByRole("button", { name: "Practice", exact: true }),
    rail.getByRole("button", { name: "Focus mode", exact: true }),
  ];
  for (const button of shortDesktopButtons) {
    await hitTestRailButton(button);
    await expectNoDocumentHorizontalOverflow(page);
  }

  await page.setViewportSize({ width: 390, height: 520 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const mobileLibrary = rail.getByRole("button", { name: "Browse melody library", exact: true });
  const projectsButton = rail.getByRole("button", { name: "Projects", exact: true });
  const mobilePractice = rail.getByRole("button", { name: "Practice", exact: true });
  const focusButton = rail.getByRole("button", { name: "Focus mode", exact: true });

  // Scroll each rail target into view before a Playwright hit test. This also
  // exercises any local rail scrolling without allowing document overflow.
  for (const button of [mobileLibrary, projectsButton, inspectorButton, mobilePractice, focusButton]) {
    await hitTestRailButton(button);
    await expectNoDocumentHorizontalOverflow(page);
  }

  await projectsButton.scrollIntoViewIfNeeded();
  await projectsButton.click();
  const projectsPanel = page.getByTestId("projects-panel");
  await expect(projectsPanel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(projectsPanel).toBeHidden();
  await expect(projectsButton).toBeFocused();

  await inspectorButton.scrollIntoViewIfNeeded();
  await inspectorButton.click();
  await expect(inspectorPanel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inspectorPanel).toBeHidden();
  await expect(inspectorButton).toBeFocused();

  await focusButton.scrollIntoViewIfNeeded();
  await focusButton.click();
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "on");
  await page.keyboard.press("Escape");
  await expect(focusButton).toHaveAttribute("aria-pressed", "false");
  await expect(projectsButton).toBeVisible();

  await inspectorButton.scrollIntoViewIfNeeded();
  await inspectorButton.click();
  await expect(inspectorPanel).toBeVisible();
  await expect(inspectorPanel.getByRole("tab", { name: "Audio", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(inspectorPanel).toBeHidden();
  await expect(inspectorButton).toBeFocused();
  await expectNoDocumentHorizontalOverflow(page);

  const mobilePath = testInfo.outputPath("rail-mobile-390x520.png");
  await page.screenshot({ path: mobilePath });
  await testInfo.attach("rail-mobile-390x520", { path: mobilePath, contentType: "image/png" });
});
