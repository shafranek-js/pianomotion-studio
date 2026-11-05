import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createGmBank } from "./fixtures/syntheticBackingBank";
import { createSyntheticMonoSf2 } from "../../apps/client/src/audio/soundfont/testing/syntheticMonoSf2";
import { configureStudioTestOutput, expectStudioCanvas, openStudioInspector, waitForLoadingToClear } from "./studio-helpers";

function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  for (value >>>= 7; value > 0; value >>>= 7) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

function trackChunk(events: number[]): number[] {
  return [0x4d, 0x54, 0x72, 0x6b, (events.length >>> 24) & 255, (events.length >>> 16) & 255,
    (events.length >>> 8) & 255, events.length & 255, ...events];
}

function instrumentTrack(name: string, program: number, pitch: number): number[] {
  const nameBytes = [...new TextEncoder().encode(name)];
  return [0, 0xff, 0x03, nameBytes.length, ...nameBytes, 0, 0xc0, program,
    0, 0x90, pitch, 90, ...vlq(480), 0x80, pitch, 0, 0, 0xff, 0x2f, 0];
}

function mixedMidi(): Uint8Array {
  const tracks = [
    trackChunk(instrumentTrack("Piano", 0, 60)),
    trackChunk(instrumentTrack("Violin", 40, 67)),
    trackChunk(instrumentTrack("Cello", 42, 48)),
    trackChunk(instrumentTrack("Strings", 48, 72)),
  ];
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, 1, 0xe0, ...tracks.flat()]);
}

async function activateBank(page: Page, bank: Buffer): Promise<void> {
  const bankId = createHash("sha256").update(bank).digest("hex");

  await page.goto("/?empty=true");
  await waitForLoadingToClear(page);
  await configureStudioTestOutput(page);
  await page.locator("#midi-file").setInputFiles({
    name: "piano-violin-cello.mid",
    mimeType: "audio/midi",
    buffer: Buffer.from(mixedMidi()),
  });
  await expectStudioCanvas(page, 60_000);
  await waitForLoadingToClear(page);

  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  await page.locator("#settings-sound-output").selectOption("soundfont");
  await page.locator('input[type="file"][accept=".sf2,.sf3"]').setInputFiles({
    name: "Synthetic backing.sf2",
    mimeType: "audio/sf2",
    buffer: bank,
  });
  await expect(page.locator("#settings-soundfont-select")).toHaveValue(bankId, { timeout: 45_000 });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await openStudioInspector(page, "Audio");
}

test("a local piano bank automatically uses included GM backing and clears source messages when switching outputs", async ({ page }) => {
  test.setTimeout(180_000);
  await activateBank(page, Buffer.from(createSyntheticMonoSf2()));
  const outputStatus = page.getByTestId("inspector-panel").locator('p[role="status"]');
  await expect(outputStatus).toContainText("Active output: Local SoundFont; backing: MuseScore General v0.2", { timeout: 90_000 });
  await expect(outputStatus).toContainText("built-in GM: Violin, Cello, Strings (MuseScore General v0.2)");
  await expect(outputStatus).not.toContainText("synth fallback:");
  await expect(outputStatus).not.toContainText("unavailable");

  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(page.getByTestId("inspector-panel")).toBeHidden();
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  await page.locator("#settings-sound-output").selectOption("synth");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await openStudioInspector(page, "Audio");
  await expect(outputStatus).toContainText("Active output: Built-in synthesizer; backing: built-in synth", { timeout: 30_000 });
  await expect(outputStatus).not.toContainText("synth fallback:");
  await expect(outputStatus).not.toContainText("built-in GM:");
  await expect(outputStatus).not.toContainText("unavailable");
});

test("unavailable included GM keeps the selected primary instruments and visibly uses synth only for missing tracks", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/soundfonts/musescore-general/*.sf3", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await activateBank(page, Buffer.from(createGmBank()));
  const outputStatus = page.getByTestId("inspector-panel").locator('p[role="status"]');
  await expect(outputStatus).toContainText("Active output: Local SoundFont; backing: Local SoundFont (Violin, Cello) + built-in synth", { timeout: 45_000 });
  await expect(outputStatus).toContainText("synth fallback: Strings");
  await expect(outputStatus).toContainText("built-in GM unavailable:");
  await expect(outputStatus).toContainText("HTTP 503");
  await expect(outputStatus).not.toContainText("synth fallback: Violin");
  await expect(outputStatus).not.toContainText("built-in GM: Violin");
});

test("undecodable included GM samples keep the selected PCM bank usable with explicit synth fallback", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const original = BaseAudioContext.prototype.decodeAudioData;
    BaseAudioContext.prototype.decodeAudioData = function (...args: Parameters<typeof original>) {
      const header = new Uint8Array(args[0], 0, Math.min(4, args[0].byteLength));
      if (header[0] === 0x4f && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53) {
        const error = new DOMException("Included Ogg decoder unavailable", "EncodingError");
        args[2]?.(error);
        return Promise.reject(error);
      }
      return original.apply(this, args);
    };
  });
  await activateBank(page, Buffer.from(createGmBank()));
  const outputStatus = page.getByTestId("inspector-panel").locator('p[role="status"]');
  await expect(outputStatus).toContainText("Active output: Local SoundFont; backing: Local SoundFont (Violin, Cello) + built-in synth", { timeout: 90_000 });
  await expect(outputStatus).toContainText("synth fallback: Strings");
  await expect(outputStatus).toContainText("built-in GM unavailable: Sample preparation failed:");
  await expect(outputStatus).not.toContainText("built-in GM: Strings");
});
