import { expect, test } from "@playwright/test";
import { loadStudioSong, openStudioInspector } from "./studio-helpers";

function createTestWavBuffer(durationSec = 2, sampleRate = 8000): Buffer {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataByteCount = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataByteCount);

  // RIFF chunk descriptor
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataByteCount, 4);
  buffer.write("WAVE", 8);

  // fmt subchunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat 1 = PCM
  buffer.writeUInt16LE(1, 22); // NumChannels = 1
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate = SampleRate * NumChannels * BitsPerSample/8
  buffer.writeUInt16LE(2, 32); // BlockAlign = NumChannels * BitsPerSample/8
  buffer.writeUInt16LE(16, 34); // BitsPerSample = 16

  // data subchunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataByteCount, 40);

  // Audio samples: 440 Hz tone
  for (let i = 0; i < numSamples; i++) {
    const val = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000);
    buffer.writeInt16LE(val, 44 + i * 2);
  }

  return buffer;
}

test.describe("M6 Visual Hand Skins & Audio Sync (W039–W044)", () => {
  test("customizes skin styles, toggles shadow, uploads audio track, and renders waveform", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await loadStudioSong(page, { output: "soundfont" });

    // 3. Open Settings Modal
    const settingsBtn = page.getByRole("button", {name: "Open preferences", exact: true});
    await settingsBtn.click();
    await expect(page.locator("#settings-modal-title")).toBeVisible();

    // 4. Test Hand Skin Style Selection
    const skinStyleSelect = page.locator("#settings-skin-style");
    await expect(skinStyleSelect).toHaveValue("realistic");

    await skinStyleSelect.selectOption("gloves");
    await expect(skinStyleSelect).toHaveValue("gloves");

    await skinStyleSelect.selectOption("robot");
    await expect(skinStyleSelect).toHaveValue("robot");

    await skinStyleSelect.selectOption("skeleton");
    await expect(skinStyleSelect).toHaveValue("skeleton");

    // 5. Test Hand Drop Shadow Toggle
    const shadowCheckbox = page.locator("#settings-hand-shadow");
    await expect(shadowCheckbox).toBeChecked();
    await shadowCheckbox.uncheck();
    await expect(shadowCheckbox).not.toBeChecked();
    await shadowCheckbox.check();
    await expect(shadowCheckbox).toBeChecked();

    // 6. Test Audio Output Engine Selection
    const soundOutputSelect = page.locator("#settings-sound-output");
    await expect(soundOutputSelect).toHaveValue("soundfont");

    await expect(soundOutputSelect.locator('option[value="soundfont"]')).toBeEnabled();
    await expect(soundOutputSelect.locator('option[value="webmidi"]')).toBeEnabled();
    await soundOutputSelect.selectOption("soundfont");
    await expect(page.locator("#settings-soundfont-select option:checked")).toContainText("MuseScore General");

    // Close settings modal
    await page.locator('button[aria-label="Close"]').click();
    await expect(page.locator("#settings-modal-title")).not.toBeVisible();

    await page.getByRole("button", {name: "Fingering", exact: true}).click();
    await openStudioInspector(page, "Audio");
    await expect(page.getByText("Active output: MuseScore General v0.2", {exact:true})).toBeVisible();
    // Explicitly select the lightweight synth for the recording scenario.
    await settingsBtn.click();
    await page.locator("#settings-sound-output").selectOption("synth");
    await page.locator('button[aria-label="Close"]').click();

    // 7. Test External Audio Sync Recording Upload
    const uploadInput = page.locator("#audio-track-file-input");
    const testWav = createTestWavBuffer(2.5, 8000);

    await uploadInput.setInputFiles({
      name: "performance-recording.wav",
      mimeType: "audio/wav",
      buffer: testWav,
    });

    // 8. Verify Waveform Canvas Renders
    await expect(page.locator("#audio-waveform-container")).toBeVisible({ timeout: 5_000 });
    const waveformCanvas = page.locator("#audio-waveform-container canvas");
    await expect(waveformCanvas).toBeVisible();

    // Verify clear button appears
    const clearBtn = page.locator("#audio-track-clear-btn");
    await expect(clearBtn).toBeVisible();

    // 9. Remove Audio Track
    await clearBtn.click();
    await expect(page.locator("#audio-waveform-container")).not.toBeVisible();
    await expect(clearBtn).not.toBeVisible();

    // 10. Verify zero browser page errors
    expect(pageErrors).toEqual([]);
  });
});
