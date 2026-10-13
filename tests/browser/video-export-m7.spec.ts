import { expect, test } from "@playwright/test";

test.describe("M7 Offline / Real-Time Video Export (W045–W049, Gate G7)", () => {
  test("opens export modal, configures presets, handles cancellation, and performs full export with video and audio downloads", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/");

    // 1. Select tracked-right-hand fixture and analyze
    await page.locator("#fixture-select").selectOption("tracked-right-hand");
    await page.locator("#analyze-button").click();

    // 2. Wait for player card to appear
    await expect(page.locator(".player-card")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#piano-canvas-container canvas")).toBeVisible({
      timeout: 5_000,
    });

    // 3. Verify Export Video button in persistence bar
    const exportBtn = page.locator("#player-export-video-button");
    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).toBeEnabled();

    // 4. Open Export Modal
    await exportBtn.click();
    const modalTitle = page.locator("#video-export-modal-title");
    await expect(modalTitle).toBeVisible();
    await expect(modalTitle).toContainText("Export Performance Video");

    // 5. Verify controls & presets
    const resolutionSelect = page.locator("#export-resolution-select");
    await expect(resolutionSelect).toBeVisible();
    await resolutionSelect.selectOption("720p");
    expect(await resolutionSelect.inputValue()).toBe("720p");

    const fpsSelect = page.locator("#export-fps-select");
    await expect(fpsSelect).toBeVisible();
    await fpsSelect.selectOption("30");
    expect(await fpsSelect.inputValue()).toBe("30");

    const audioCheckbox = page.locator("#export-audio-checkbox");
    await expect(audioCheckbox).toBeVisible();
    expect(await audioCheckbox.isChecked()).toBe(true);

    const audioSourceSelect = page.locator("#export-audio-source-select");
    await expect(audioSourceSelect).toBeVisible();

    // 6. Test Export Cancellation Workflow
    const startBtn = page.locator("#start-export-btn");
    await expect(startBtn).toBeVisible();
    await startBtn.click();

    // Verify cancel button becomes active during export
    const cancelBtn = page.locator("#cancel-export-btn");
    await expect(cancelBtn).toBeVisible({ timeout: 5_000 });
    await cancelBtn.click();

    // Verify cancellation state
    await expect(page.locator("#export-status-text")).toContainText("cancelled", {
      timeout: 5_000,
      ignoreCase: true,
    });
    // Start export button returns when cancelled
    await expect(page.locator("#start-export-btn")).toBeVisible({ timeout: 5_000 });

    // 7. Test Full Export Completion Workflow
    await page.locator("#start-export-btn").click();

    // Wait for download buttons upon completion
    const downloadVideoBtn = page.locator("#download-video-btn");
    await expect(downloadVideoBtn).toBeVisible({ timeout: 45_000 });
    await expect(downloadVideoBtn).toContainText("Download Video");

    const downloadAudioBtn = page.locator("#download-audio-btn");
    await expect(downloadAudioBtn).toBeVisible();
    await expect(downloadAudioBtn).toContainText("Download WAV");

    const statusText = page.locator("#export-status-text");
    await expect(statusText).toContainText("completed successfully", {
      ignoreCase: true,
    });

    // 8. Close Modal
    const closeBtn = page.locator("#export-close-btn");
    await closeBtn.click();
    await expect(modalTitle).not.toBeVisible();

    // 9. Zero page errors
    expect(pageErrors).toEqual([]);
  });
});
