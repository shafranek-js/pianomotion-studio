import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { M1AnalyzeMidiResult } from "@handthesia/contracts";
import { compareM1ResultToGolden, type GoldenFixture, type FixtureParity } from "../parity/compare";
import { openStudioInspector } from "./studio-helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");
const GOLDEN_DIR = path.resolve(FIXTURES_DIR, "golden");
const manifestPath = path.resolve(FIXTURES_DIR, "manifest.json");

type Manifest = {
  fixtureSources: Record<
    string,
    {
      fixturePath: string;
      fixtureSha256: string;
      scenarios?: string[];
      kind?: string;
    }
  >;
};

const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const fixtureIds = Object.keys(manifest.fixtureSources).sort();

test.describe.serial("M1 Pyodide browser verification suite", () => {
  // Allow ample time for Pyodide cold start and full 13-fixture matrix
  test.setTimeout(240_000);

  let page: Page;
  const pageErrors: string[] = [];
  const analysisWorkerUrls: string[] = [];
  const benchmarkResults: {
    fixtureId: string;
    durationMs: number;
    coldStart: boolean;
    memoryBytes?: number;
    status: string;
    differencesCount: number;
  }[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() !== "debug") {
        console.log(`[BROWSER ${msg.type()}]`, msg.text());
      }
    });
    page.on("pageerror", (error) => {
      console.log(`[PAGE ERROR STACK]`, error.stack);
      if ("issues" in error) {
        console.log(`[PAGE ERROR ISSUES]`, JSON.stringify((error as { issues: unknown }).issues, null, 2));
      }
      pageErrors.push(error.stack || error.message);
    });
    page.on("worker", (worker) => {
      const url = worker.url();
      console.log(`[WORKER CREATED]`, url);
      if (url.includes("midi-analysis.worker") || url.includes("midi-analysis-ts.worker")) {
        analysisWorkerUrls.push(url);
      }
    });

    await page.goto("/?empty=true");
    await expect(page).toHaveTitle("PianoMotion Studio");

    await page.getByRole("button", { name: "Open preferences", exact: true }).click();
    const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
    await expect(preferences).toBeVisible();
    const engineSelector = preferences.locator("#settings-calculation-engine");
    await engineSelector.selectOption("python");
    await expect(engineSelector).toHaveValue("python");
    await expect.poll(() => page.evaluate(async () =>
      (await import("/src/settings/settingsStore.ts")).getSettings().calculationEngine,
    )).toBe("python");
    await preferences.getByRole("button", { name: "Done", exact: true }).click();

    await openDeveloperTools();
    await expect(page.locator("#fixture-select")).toBeEnabled({ timeout: 30_000 });
  });

  async function openDeveloperTools() {
    await openStudioInspector(page, "Diagnostics");
    if (!await page.locator("#fixture-select").isVisible()) {
      await page.getByText("Developer tools", {exact:true}).click();
    }
  }

  test.afterAll(async () => {
    if (page) {
      await page.close();
    }
    console.log("\n=== M1 BENCHMARK SUMMARY ===");
    for (const b of benchmarkResults) {
      console.log(
        JSON.stringify({
          fixture: b.fixtureId,
          durationMs: b.durationMs,
          cold: b.coldStart,
          status: b.status,
          differences: b.differencesCount,
          memoryMb: b.memoryBytes ? Number((b.memoryBytes / (1024 * 1024)).toFixed(2)) : undefined,
        }),
      );
    }
    console.log("============================\n");
  });

  async function runFixtureAnalysis(fixtureId: string): Promise<{
    result: M1AnalyzeMidiResult;
    durationMs: number;
    memoryBytes?: number;
  }> {
    await openDeveloperTools();
    const fixtureSelect = page.locator("#fixture-select");
    await expect(fixtureSelect).toBeEnabled({ timeout: 15_000 });

    await page.evaluate(() => {
      window.__m1LastResult = null;
      window.__m1LastError = null;
    });

    await fixtureSelect.selectOption(fixtureId);

    const analyzeButton = page.locator("#analyze-button");
    await expect(analyzeButton).toBeEnabled({ timeout: 10_000 });

    const startMs = Date.now();
    await analyzeButton.click();

    await page.waitForFunction(
      () =>
        (window.__m1LastResult !== null && window.__m1LastResult !== undefined) ||
        (window.__m1LastError !== null && window.__m1LastError !== undefined) ||
        document.querySelector('[role="alertdialog"][aria-labelledby="replace-project-title"]') !== null,
      undefined,
      { timeout: 90_000 },
    );
    const replaceDialog = page.getByRole("alertdialog", {name:"Unsaved changes"});
    if (await replaceDialog.isVisible()) {
      await replaceDialog.getByRole("button", {name:"Discard and open", exact:true}).click();
    }

    const durationMs = Date.now() - startMs;

    const evaluation = await page.evaluate(() => {
      const perf = window.performance as unknown as {
        memory?: { usedJSHeapSize?: number };
      };
      return {
        result: window.__m1LastResult,
        error: window.__m1LastError,
        usedHeap: perf.memory?.usedJSHeapSize,
      };
    });

    if (evaluation.error) {
      throw new Error(`Worker analysis failed for ${fixtureId}: ${evaluation.error}`);
    }
    if (!evaluation.result) {
      throw new Error(`No result returned for ${fixtureId}`);
    }

    expect(analysisWorkerUrls.some((url) => url.includes("midi-analysis.worker"))).toBe(true);
    expect(analysisWorkerUrls.some((url) => url.includes("midi-analysis-ts.worker"))).toBe(false);

    return {
      result: evaluation.result,
      durationMs,
      memoryBytes: evaluation.usedHeap,
    };
  }

  for (let i = 0; i < fixtureIds.length; i++) {
    const fixtureId = fixtureIds[i]!;
    const isColdStart = i === 0;

    test(`fixture parity (${i + 1}/${fixtureIds.length}): ${fixtureId}`, async () => {
      const goldenPath = path.resolve(GOLDEN_DIR, `${fixtureId}.json`);
      expect(fs.existsSync(goldenPath)).toBe(true);
      const golden: GoldenFixture = JSON.parse(fs.readFileSync(goldenPath, "utf8"));

      const { result, durationMs, memoryBytes } = await runFixtureAnalysis(fixtureId);

      // Perform deep parity comparison
      const parity: FixtureParity = compareM1ResultToGolden(result, golden);

      benchmarkResults.push({
        fixtureId,
        durationMs,
        coldStart: isColdStart,
        memoryBytes,
        status: result.status,
        differencesCount: parity.differences.length,
      });

      // Verify status matches
      if (golden.status === "invalid-or-rejected") {
        expect(result.status).toBe("invalid");
      } else {
        expect(result.status).toBe(golden.status);
      }

      // Assert zero parity differences
      expect(parity.differences).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }

  test("cancellation terminates worker and disposes job", async () => {
    await openDeveloperTools();
    const fixtureSelect = page.locator("#fixture-select");
    await expect(fixtureSelect).toBeEnabled();
    // Use stress fixture so worker has real computation underway
    await fixtureSelect.selectOption("synthetic-stress-512");

    const analyzeButton = page.locator("#analyze-button");
    const cancelButton = page.locator("#cancel-button");

    await page.evaluate(() => {
      window.__m1LastResult = null;
      window.__m1LastError = null;
    });

    await analyzeButton.click();

    // Verify cancel button becomes active and cancel analysis
    await expect(cancelButton).toBeEnabled({ timeout: 5_000 });
    await cancelButton.click();

    // Verify UI reflects cancellation
    await expect(page.getByTestId("studio-status")).toContainText(
      /cancel/i,
      { timeout: 5_000 },
    );

    const lastResult = await page.evaluate(() => window.__m1LastResult);
    expect(lastResult).toBeNull();
    await expect(analyzeButton).toBeEnabled({ timeout: 5_000 });

    // Verify recovery: subsequent analysis works cleanly with a new worker
    const recovery = await runFixtureAnalysis("tracked-right-hand");
    expect(recovery.result.status).toBe("loaded");
    expect(recovery.result.document?.notes.length).toBe(22);
    expect(pageErrors).toEqual([]);
  });

  test("rejects invalid/corrupt MIDI input without crashing the worker", async () => {
    // 1. Test invalid fixture from dropdown
    const invalidRun = await runFixtureAnalysis("synthetic-invalid-non-midi");
    expect(invalidRun.result.status).toBe("invalid");
    expect(invalidRun.result.document).toBeNull();
    expect(invalidRun.result.diagnostics.length).toBeGreaterThan(0);
    expect(invalidRun.result.diagnostics[0]?.code).toBe("midi-load-failed");
    await expect(page.getByTestId("studio-status")).toContainText(/rejected|invalid|failed/i);

    // 2. Test uploaded corrupted custom file
    const fileInput = page.locator("#midi-file");
    const corruptBuffer = Buffer.from("CORRUPT_NOT_A_MIDI_HEADER_1234567890");
    await page.evaluate(() => {
      window.__m1LastResult = null;
      window.__m1LastError = null;
    });

    await fileInput.setInputFiles({
      name: "corrupt-test.mid",
      mimeType: "audio/midi",
      buffer: corruptBuffer,
    });

    await page.waitForFunction(
      () =>
        (window.__m1LastResult !== null && window.__m1LastResult !== undefined) ||
        (window.__m1LastError !== null && window.__m1LastError !== undefined),
      undefined,
      { timeout: 30_000 },
    );

    await expect(page.getByTestId("studio-status")).toContainText(/invalid|rejected|not opened|failed/i);
    // The invalid fixture above verifies the raw Worker result. The File path
    // rejects an unusable candidate and retains the currently mounted project.
    expect(await page.evaluate(() => window.__m1LastError)).toBeTruthy();

    // 3. Verify worker did not crash and can process valid input immediately
    const validRun = await runFixtureAnalysis("tracked-right-hand");
    expect(validRun.result.status).toBe("loaded");
    expect(validRun.result.document?.notes.length).toBe(22);
    expect(pageErrors).toEqual([]);
  });
});
