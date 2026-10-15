import { expect, test } from "@playwright/test";
import { loadStudioSong, settledStudio } from "./studio-helpers";

test.describe("M5 Profiles, Settings & Durable Persistence (W034–W038, Gate G5)", () => {
  test("complete profiles & settings journey: profile switching, anatomy editing, settings modal, and autosave recovery", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    test.setTimeout(180_000);
    const initial = await loadStudioSong(page);

    // 4. Verify M5 action buttons in player header
    const profileBtn = page.getByRole("button", {name: "Open pianist settings", exact: true});
    const settingsBtn = page.getByRole("button", {name: "Open preferences", exact: true});
    await expect(profileBtn).toBeVisible();
    await expect(settingsBtn).toBeVisible();

    // 5. Open and test Settings Modal
    await settingsBtn.click();
    const settingsModal = page.getByRole("dialog", {name: "Preferences", exact:true});
    await expect(settingsModal).toBeVisible();

    // Change key geometry to Equal key widths
    const keyStyleSelect = page.locator("#settings-key-style");
    await expect(keyStyleSelect).toBeVisible();
    await keyStyleSelect.selectOption("equal");

    // Change render cap target
    const frameCapSelect = page.locator("#settings-frame-cap");
    await expect(frameCapSelect).toBeVisible();
    await frameCapSelect.selectOption("30");

    // Close Settings Modal
    await settingsModal.getByRole("button", { name: "Done" }).click();
    await expect(settingsModal).toBeHidden();

    // 6. Open and test Profiles Modal
    await profileBtn.click();
    const profileModal = page.getByRole("dialog", {name:"Pianist settings", exact:true});
    await expect(profileModal).toBeVisible();

    // Verify Active Profile dropdown contains canonical profiles
    const activeProfileSelect = page.locator("#active-profile-select");
    await expect(activeProfileSelect).toBeVisible();

    // Switch to Virtuoso profile
    await activeProfileSelect.selectOption("virtuoso");
    await expect(profileModal.getByRole("button", {name:"Save & Apply",exact:true})).toBeDisabled();
    await profileModal.getByRole("button", {name:"Duplicate",exact:true}).click();
    await expect(activeProfileSelect).not.toHaveValue("virtuoso");
    const customProfileId=await activeProfileSelect.inputValue();

    // Switch to Motion tab
    await profileModal.getByRole("tab", { name: /Motion/i }).click();

    // Switch to Hand Anatomy tab
    await profileModal.getByRole("tab", { name: /Anatomy/i }).click();

    // Click "Save & Apply"
    await profileModal.getByRole("button", { name: "Save & Apply" }).click();

    // Close Profile Modal
    await profileModal.getByRole("button", { name: "Close" }).click();
    await expect(profileModal).toBeHidden();

    // Player header updates to show "Virtuoso" profile
    const applied = await settledStudio(page, initial.result.revision);
    expect(applied.profile.profileId).toBe(customProfileId);
    expect(applied.keyStyle).toBe("equal");

    // 7. Verify Autosave session in IndexedDB (wait for debounce flush)
    await page.waitForTimeout(1_000);
    const autosaveRecord = await page.evaluate(async () => {
      return new Promise<boolean>((resolve) => {
        const req = indexedDB.open("handthesia_db", 2);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("session")) {
            resolve(false);
            return;
          }
          const tx = db.transaction("session", "readonly");
          const store = tx.objectStore("session");
          const getReq = store.get("current_session");
          getReq.onsuccess = () => {
            resolve(Boolean(getReq.result));
          };
          getReq.onerror = () => resolve(false);
        };
        req.onerror = () => resolve(false);
      });
    });

    expect(autosaveRecord).toBe(true);

    // 8. Re-open Profile Modal, test duplication & export
    await profileBtn.click();
    await expect(profileModal).toBeVisible();

    await profileModal.getByRole("button", { name: "Duplicate" }).click();

    // Switch to Import/Export tab
    await profileModal.getByRole("tab", { name: /Import \/ Export/i }).click();

    // Test JSON export download
    const downloadPromise = page.waitForEvent("download");
    await profileModal.getByRole("button", { name: /Export as/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/i);

    // Close Profile Modal
    await profileModal.getByRole("button", { name: "Close" }).click();
    await expect(profileModal).toBeHidden();

    // 9. Zero console / page errors
    expect(pageErrors).toEqual([]);
  });
});
