import { expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { M1AnalyzeMidiResultSchema } from "@handthesia/contracts";

export const studioMidiPath = fileURLToPath(new URL("../fixtures/midi/tracked-right-hand.mid", import.meta.url));

export async function loadStudioSong(page: Page) {
  const base = process.env.PIANOMOTION_PREVIEW_BASE ?? "/";
  const url = base.includes("?") ? `${base}&empty=true` : `${base}?empty=true`;
  await page.goto(url);
  await expect(page).toHaveTitle("PianoMotion Studio");
  await expect(page.getByRole("button", {name:"Play demo song", exact:true})).toBeEnabled({ timeout: 30_000 });
  await page.locator("#midi-file").setInputFiles(studioMidiPath);
  await expect(page.locator("#piano-canvas-container canvas")).toBeVisible({ timeout: 90_000 });
  return settledStudio(page, 0);
}

export async function settledStudio(page: Page, minimumRevision: number) {
  await page.waitForFunction(revision => {
    const snapshot = window.__playerSnapshot;
    return (snapshot && snapshot.scene?.keyCount === 88 && !snapshot.pending && snapshot.result.revision >= revision) ||
      document.querySelector('.studio-save-state[data-kind="error"]') !== null;
  }, minimumRevision, { timeout: 90_000 });
  const snapshot = await page.evaluate(() => window.__playerSnapshot!);
  if (!snapshot || snapshot.pending || snapshot.result.revision < minimumRevision) {
    await openStudioInspector(page,"Diagnostics");
    throw new Error(`Project calculation failed: ${await page.getByTestId("inspector-panel").innerText()}`);
  }
  const result = M1AnalyzeMidiResultSchema.parse(snapshot.result);
  expect(result.performancePlan?.fingeringPlanId).toBe(result.fingeringPlan?.planId);
  expect(result.motionPlan?.performancePlanId).toBe(result.performancePlan?.planId);
  return snapshot;
}

export async function openStudioInspector(page: Page, tab: "Scene" | "Pianist" | "Audio" | "Diagnostics") {
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-layout-ready", "true");
  const focusMode = page.getByRole("button", { name: "Focus mode", exact: true });
  if (await focusMode.getAttribute("aria-pressed") === "true") await focusMode.click();
  const trigger = page.getByRole("button", { name: "Inspector", exact: true });
  // Use the trigger's state, not a potentially transitioning sheet's visibility.
  await expect(trigger).toBeVisible();
  if (await trigger.getAttribute("aria-pressed") !== "true") await trigger.click();
  await expect(page.getByTestId("inspector-panel")).toBeVisible();
  await page.getByRole("tab", { name: tab, exact: true }).click();
}

export async function exportStudioPackage(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Project package (.json)", exact: true }).click();
  const path = await (await downloaded).path();
  if (!path) throw new Error("Project package download has no local path");
  return path;
}

export async function saveStudioProject(page: Page) {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save project", exact: true }).click();
  await expect(page.locator('.studio-save-state[data-kind="saved"]')).toBeVisible();
  await expect(page.getByTestId("studio-status").getByRole("status")).toHaveText("Project saved to this browser.");
}

export async function focusStudioScene(page: Page) {
  const canvas = page.locator("#piano-canvas-container canvas");
  await canvas.focus();
  return canvas;
}

export async function openStudioEditMenu(page: Page) {
  const trigger = page.getByRole("button", {name: "Edit", exact: true});
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
}
