import { expect, test } from "@playwright/test";
import { expectStudioCanvas, loadStudioSong, saveStudioProject, settledStudio, studioCanvas } from "./studio-helpers";

test("update never activates after real project transaction abort; edited session survives", async ({ page }) => {
  test.setTimeout(180_000);
  const original = await loadStudioSong(page, { output: "synth", dimension: "2d" });
  await saveStudioProject(page);
  await page.getByRole("button", { name: "Fingering", exact: true }).click();
  const canvas = studioCanvas(page, "2d");
  await expect(canvas).toBeVisible();
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByTestId("studio-header").getByRole("button", { name: "Finger 4", exact: true }).click();
  const edited = await settledStudio(page, original.result.revision + 1);
  await page.evaluate(() => {
    const state = window as typeof window & { updateActivations?: number; projectPutAborted?: boolean };
    state.updateActivations = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (this.name === "projects") {
        const tx = this.transaction;
        request.addEventListener("success", () => { state.projectPutAborted = true; tx.abort(); }, { once: true });
      }
      return request;
    };
    window.dispatchEvent(new CustomEvent("sw-update-available", { detail: { registration: {
      waiting: { postMessage: () => { state.updateActivations! += 1; } },
    } } }));
  });
  await page.getByRole("button", { name: "Update ready", exact: true }).click();
  await expect(page.getByTestId("studio-status")).toContainText(/update could not be applied/i);
  expect(await page.evaluate(() => (window as typeof window & { projectPutAborted: boolean }).projectPutAborted)).toBe(true);
  expect(await page.evaluate(() => (window as typeof window & { updateActivations: number }).updateActivations)).toBe(0);
  const retained = await page.evaluate(() => window.__playerSnapshot!);
  expect(retained.result.projectId).toBe(original.result.projectId);
  expect(retained.draftPlan.assignments).toEqual(edited.draftPlan.assignments);
  await expectStudioCanvas(page);
});

test("edits made during worker activation prevent the final reload", async ({ page }) => {
  test.setTimeout(180_000);
  const original = await loadStudioSong(page, { output: "synth", dimension: "2d" });
  await page.getByRole("button", { name: "Fingering", exact: true }).click();
  const canvas = studioCanvas(page, "2d");
  await expect(canvas).toBeVisible();
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await page.evaluate(() => {
    const state = window as typeof window & { updateActivationRequested?: boolean };
    state.updateActivationRequested = false;
    window.dispatchEvent(new CustomEvent("sw-update-available", { detail: { registration: {
      waiting: { postMessage: () => { state.updateActivationRequested = true; } },
    } } }));
  });
  await page.getByRole("button", { name: "Update ready", exact: true }).click();
  await page.waitForFunction(() => (window as typeof window & { updateActivationRequested?: boolean }).updateActivationRequested);
  // The SW can take time to activate after a committed save. A new musical edit
  // in that interval must retain the old live tab, even though activation succeeds.
  await page.getByTestId("studio-header").getByRole("button", { name: "Finger 4", exact: true }).click();
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event("controllerchange")));
  await expect(page.getByTestId("studio-status")).toContainText(/update activated without reloading/i);
  await expect(page.getByRole("button", { name: "Update ready", exact: true })).toHaveCount(0);
  const retained = await page.evaluate(() => window.__playerSnapshot!);
  expect(retained.result.projectId).toBe(original.result.projectId);
  expect(retained.draftPlan.assignments.some((item) => item.fingerMode === "manual" && item.finger === 4)).toBe(true);
  await expectStudioCanvas(page);
});
