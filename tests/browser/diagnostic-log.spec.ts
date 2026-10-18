import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import { openStudioInspector } from "./studio-helpers";

test("local diagnostic history survives reload and downloads from an empty studio", async ({ page }, testInfo) => {
  await page.goto("/?empty=true");
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled();
  const marker = "Diagnostic acceptance: intentional browser exception";
  const expectedError = page.waitForEvent("pageerror");
  await page.evaluate(message => { setTimeout(() => { throw new Error(message); }, 0); }, marker);
  expect((await expectedError).message).toContain(marker);
  await expect.poll(() => page.evaluate(message =>
    localStorage.getItem("pianomotion.diagnostics.v1")?.includes(message) ?? false, marker)).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled();
  await openStudioInspector(page, "Diagnostics");
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download diagnostic log", exact: true }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toMatch(/^pianomotion-diagnostics-.*\.json$/);
  const outputPath = testInfo.outputPath("diagnostic-history.json");
  await download.saveAs(outputPath);
  const log = JSON.parse(await fs.readFile(outputPath, "utf8")) as {
    schemaVersion: number; appVersion: string; events: { event: string; sessionId: string; details: unknown }[];
  };
  expect(log.schemaVersion).toBe(1);
  const packageInfo = JSON.parse(await fs.readFile(new URL("../../apps/client/package.json", import.meta.url), "utf8"));
  expect(log.appVersion).toBe(packageInfo.version);
  expect(log.events.some(entry => entry.event === "browser.error" && JSON.stringify(entry.details).includes(marker))).toBe(true);
  expect(new Set(log.events.filter(e => e.event === "session.started").map(e => e.sessionId)).size).toBeGreaterThanOrEqual(2);
  await testInfo.attach("diagnostic-history", { path: outputPath, contentType: "application/json" });
  await page.getByRole("button", { name: "Clear diagnostic log", exact: true }).click();
  await expect.poll(() => page.evaluate(message =>
    localStorage.getItem("pianomotion.diagnostics.v1")?.includes(message) ?? false, marker)).toBe(false);
  // Clearing the journal leaves persistence for projects/settings intact.
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled();
});
