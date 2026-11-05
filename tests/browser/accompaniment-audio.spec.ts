import { expect, test } from "@playwright/test";

test("accompaniment sampler renders audio and cancels muted, panicked, and future voices", async ({ page }) => {
  await page.goto("/");
  const metrics = await page.evaluate(async () => {
    const { AccompanimentSampler } = await import("/src/audio/accompaniment.ts");
    const sampleRate = 48_000;
    const render = async (mode: "enabled" | "disabled" | "zero-volume" | "panic-future") => {
      const context = new OfflineAudioContext(2, sampleRate, sampleRate);
      const sampler = new AccompanimentSampler({
        audioContext: context as unknown as AudioContext,
        destinationNode: context.destination,
        initialVolume: mode === "zero-volume" ? 0 : 1,
        initialEnabled: mode !== "disabled",
      });
      if (mode === "panic-future") {
        sampler.noteOn("future", 52, 120, 48, 0.2);
        sampler.allNotesOff();
      } else {
        sampler.noteOn("voice", 52, 120, 48, 0.02);
        sampler.noteOff("voice", 0.35);
      }
      const buffer = await context.startRendering();
      sampler.dispose();
      let energy = 0;
      let samples = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let frame = Math.round(0.05 * sampleRate); frame < Math.round(0.3 * sampleRate); frame += 1) {
          energy += data[frame]! * data[frame]!;
          samples += 1;
        }
      }
      return Math.sqrt(energy / Math.max(1, samples));
    };
    return {
      enabledRms: await render("enabled"),
      disabledRms: await render("disabled"),
      zeroVolumeRms: await render("zero-volume"),
      panicFutureRms: await render("panic-future"),
    };
  });

  expect(metrics.enabledRms).toBeGreaterThan(0.005);
  expect(metrics.disabledRms).toBeLessThan(1e-8);
  expect(metrics.zeroVolumeRms).toBeLessThan(1e-8);
  expect(metrics.panicFutureRms).toBeLessThan(1e-8);
});
