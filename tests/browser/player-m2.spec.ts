import { expect, test } from "@playwright/test";

test.describe("M2 Vertical Browser Player MVP (W015–W022)", () => {
  test("end-to-end user journey: analysis, player rendering, playback, and persistence", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/");

    // 1. Check title & page header
    await expect(page).toHaveTitle("PianoMotion Studio · MIDI diagnostics");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "MIDI analysis diagnostics",
    );

    // 2. Select a fixture and run analysis
    await page.locator("#fixture-select").selectOption("tracked-right-hand");
    await page.locator("#analyze-button").click();

    // 3. Wait for analysis to complete and player card to appear
    await expect(page.locator(".player-card")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#piano-canvas-container canvas")).toBeVisible({
      timeout: 5_000,
    });

    // 4. Verify transport controls
    const playButton = page.locator("#player-play-button");
    const stopButton = page.locator("#player-stop-button");
    const seekSlider = page.locator("#player-seek-slider");

    await expect(playButton).toContainText("Play");

    // Click Play -> starts playback
    await playButton.click();
    await expect(playButton).toContainText("Pause");

    // Wait 1.5 seconds and assert time has advanced
    await page.waitForTimeout(1500);
    const timeVal = await seekSlider.inputValue();
    expect(parseFloat(timeVal)).toBeGreaterThan(-2.0);

    // Click Pause
    await playButton.click();
    await expect(playButton).toContainText("Play");

    // Seek to 1.0s
    await seekSlider.evaluate((el: HTMLInputElement) => {
      el.value = "1.0";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Click Stop
    await stopButton.click();
    const stoppedTime = await seekSlider.inputValue();
    expect(parseFloat(stoppedTime)).toBeLessThanOrEqual(-1.9);

    // 5. Change Speed & KeyStyle
    await page.locator("#player-speed-select").selectOption("1.25");
    await page.locator("#player-keystyle-select").selectOption("equal");

    // 6. Test Persistence: Save to IndexedDB
    const saveButton = page.locator("#player-save-db-button");
    await saveButton.click();
    await expect(page.locator(".save-status-msg")).toContainText(
      "Project saved to IndexedDB",
      { timeout: 5_000 },
    );

    // Verify record in IndexedDB via browser evaluate
    const dbRecordExists = await page.evaluate(async () => {
      return new Promise<boolean>((resolve) => {
        const req = indexedDB.open("handthesia_db");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("projects", "readonly");
          const store = tx.objectStore("projects");
          const countReq = store.count();
          countReq.onsuccess = () => resolve(countReq.result > 0);
          countReq.onerror = () => resolve(false);
        };
        req.onerror = () => resolve(false);
      });
    });
    expect(dbRecordExists).toBe(true);

    // 7. Verify zero unhandled browser errors occurred
    expect(pageErrors).toEqual([]);
  });
});
