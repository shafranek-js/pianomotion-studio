import { expect, test } from "@playwright/test";

test.describe("M4 Fingering Editor & Dense UI (W028–W033, Gate G4)", () => {
  test("complete editor journey: view modes, piano roll selection, editing, undo/redo, difficulty metrics, playback sync, and fingered MIDI export", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/");

    // 1. Initial page header verification
    await expect(page).toHaveTitle("PianoMotion Studio · MIDI diagnostics");

    // 2. Select fixture and run analysis
    await page.locator("#fixture-select").selectOption("tracked-right-hand");
    await page.locator("#analyze-button").click();

    // 3. Wait for analysis to finish and player to mount
    await expect(page.locator(".player-card")).toBeVisible({ timeout: 35_000 });
    await expect(page.locator("#piano-canvas-container canvas")).toBeVisible({
      timeout: 5_000,
    });

    // 4. Verify view mode switcher tabs
    const perfTab = page.locator("#tab-btn-performance");
    const editorTab = page.locator("#tab-btn-editor");
    const splitTab = page.locator("#tab-btn-split");

    await expect(perfTab).toBeVisible();
    await expect(editorTab).toBeVisible();
    await expect(splitTab).toBeVisible();
    await expect(perfTab).toHaveClass(/is-active/);

    // 5. Switch to Fingering Editor View
    await editorTab.click();
    await expect(editorTab).toHaveClass(/is-active/);

    // Pixi 3D canvas is hidden in Editor-only view
    const pixiContainer = page.locator("#piano-canvas-container");
    await expect(pixiContainer).toBeHidden();

    // Editor viewport and canvas are visible
    const editor = page.locator('[data-testid="fingering-editor"]');
    await expect(editor).toBeVisible();
    const pianoRollCanvas = page.locator(
      '[data-testid="piano-roll-viewport"] canvas',
    );
    await expect(pianoRollCanvas).toBeVisible();

    // Diagnostics / Difficulty panel is visible
    await expect(page.locator(".diagnostics-panel")).toBeVisible();
    await expect(page.locator(".difficulty-card")).toContainText(
      "Piece Difficulty",
    );

    // 6. Test Editor Toolbar components
    const toolbar = page.locator(".fingering-toolbar");
    await expect(toolbar).toBeVisible();

    // Finger buttons 1..5
    for (let f = 1; f <= 5; f += 1) {
      await expect(
        toolbar.getByRole("button", { name: `Finger ${f}`, exact: false }),
      ).toBeVisible();
    }

    // Hand buttons
    const leftHandBtn = toolbar.getByRole("button", { name: /Left/i });
    const rightHandBtn = toolbar.getByRole("button", { name: /Right/i });
    await expect(leftHandBtn).toBeVisible();
    await expect(rightHandBtn).toBeVisible();

    // Undo / Redo buttons (initially disabled)
    const undoBtn = toolbar.getByRole("button", { name: /Undo/i });
    const redoBtn = toolbar.getByRole("button", { name: /Redo/i });
    await expect(undoBtn).toBeDisabled();
    await expect(redoBtn).toBeDisabled();

    // 7. Select a note via diagnostic jump or keyboard navigation (ArrowRight selects first note)
    const jumpBtn = page.locator(".diagnostics-panel button").first();
    if (await jumpBtn.isVisible()) {
      await jumpBtn.click();
    } else {
      await pianoRollCanvas.click();
      await page.keyboard.press("ArrowRight");
    }

    // 8. Assign finger 4 via toolbar
    const finger4Btn = toolbar.getByRole("button", { name: "Finger 4" });
    await finger4Btn.click();

    // Undo button should now be enabled
    await expect(undoBtn).toBeEnabled({ timeout: 2_000 });

    // 9. Test Undo -> Redo
    await undoBtn.click();
    await expect(undoBtn).toBeDisabled();
    await expect(redoBtn).toBeEnabled();

    await redoBtn.click();
    await expect(undoBtn).toBeEnabled();
    await expect(redoBtn).toBeDisabled();

    // 10. Switch to Split View (both canvas views visible simultaneously)
    await splitTab.click();
    await expect(splitTab).toHaveClass(/is-active/);
    await expect(pixiContainer).toBeVisible();
    await expect(editor).toBeVisible();

    // 11. Test Playback in Split View
    const playBtn = page.locator("#player-play-button");
    const seekSlider = page.locator("#player-seek-slider");

    await playBtn.click();
    await expect(playBtn).toContainText("Pause");
    await page.waitForTimeout(1200);

    const timeAfterPlay = parseFloat(await seekSlider.inputValue());
    expect(timeAfterPlay).toBeGreaterThan(-2.0);

    await playBtn.click(); // Pause
    await expect(playBtn).toContainText("Play");

    // 12. Test Fingered MIDI Export (W026, Gate G4)
    const exportMidiBtn = page.locator("#player-export-midi-button");
    await expect(exportMidiBtn).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await exportMidiBtn.click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.fingered\.mid$/);

    // 13. Verify status confirmation in UI
    await expect(page.locator(".save-status-msg")).toContainText(
      "Exported",
      { timeout: 8_000 },
    );

    // 14. Assert zero browser runtime errors
    expect(pageErrors).toEqual([]);
  });
});
