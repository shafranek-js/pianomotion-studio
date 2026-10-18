import { expect, test } from "@playwright/test";

test("real Signalsmith recording playback repeats future A–B segments at the requested output times", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const productionCsp = "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self' blob:; object-src 'none'; base-uri 'self';";
  let cspWasInjected = false;
  await page.route((url) => url.pathname === "/", async (route) => {
    const response = await route.fetch();
    const originalHtml = await response.text();
    const html = originalHtml.replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="${productionCsp}">`,
    );
    cspWasInjected = html !== originalHtml;
    await route.fulfill({ response, body: html });
  });
  await page.goto("/");
  expect(cspWasInjected, "the test origin must load bundled worklet/WASM code under the production CSP").toBe(true);

  const result = await page.evaluate(async () => {
    const { SyncedAudioSource } = await import("/src/audio/recording/syncedAudioSource.ts");
    const sampleRate = 48_000;
    const recordingDuration = 3;
    const frameCount = sampleRate * recordingDuration;
    const recordingChannels = [new Float32Array(frameCount), new Float32Array(frameCount)];
    const frequencies = [220, 440, 880];
    for (let frame = 0; frame < frameCount; frame += 1) {
      const section = Math.min(2, Math.floor(frame / sampleRate));
      const sample = 0.35 * Math.sin((2 * Math.PI * frequencies[section]! * frame) / sampleRate);
      recordingChannels[0]![frame] = sample;
      recordingChannels[1]![frame] = sample;
    }

    const inputBuffer = {
      numberOfChannels: 2,
      sampleRate,
      length: frameCount,
      duration: recordingDuration,
      getChannelData(channel: number) { return recordingChannels[channel]!; },
    } as unknown as AudioBuffer;
    const recording = {
      buffer: inputBuffer,
      durationSeconds: recordingDuration,
      sampleRate,
      numberOfChannels: 2,
      peaks: new Float32Array(0),
    };
    const loopStart = 0.5;
    const loopEnd = 1.5;
    const cycleOutputSeconds = loopEnd - loopStart;
    const renderedSeconds = 2.9;
    const context = new OfflineAudioContext(2, Math.ceil(renderedSeconds * sampleRate), sampleRate);
    const source = new SyncedAudioSource();
    const errors: string[] = [];
    source.subscribeError((error: Error) => errors.push(error.message));
    // OfflineAudioContext has the same attach-time surface used here; live time
    // advancement is exercised by the worklet during startRendering().
    await source.attach(recording, context as unknown as AudioContext, context.destination);
    await source.play(loopStart, 1);

    // Three future segments exercise two wraps. Each seekAt targets the exact
    // AudioContext output boundary while preserving the running source before it.
    await source.seekAt(loopStart, 1, cycleOutputSeconds);
    await source.seekAt(loopStart, 1, cycleOutputSeconds * 2);
    const rendered = await context.startRendering();
    const output = rendered.getChannelData(0);
    const measure = (centerSeconds: number) => {
      const halfWindowSeconds = 0.08;
      const first = Math.round((centerSeconds - halfWindowSeconds) * sampleRate);
      const last = Math.round((centerSeconds + halfWindowSeconds) * sampleRate);
      const levels = frequencies.map((frequency) => {
        let real = 0;
        let imaginary = 0;
        for (let frame = first; frame < last; frame += 1) {
          const value = output[frame]!;
          const phase = (2 * Math.PI * frequency * frame) / sampleRate;
          real += value * Math.cos(phase);
          imaginary += value * Math.sin(phase);
        }
        return (2 * Math.hypot(real, imaginary)) / Math.max(1, last - first);
      });
      const peakIndex = levels.indexOf(Math.max(...levels));
      return { centerSeconds, peakHz: frequencies[peakIndex]!, peakAmplitude: levels[peakIndex]!, levels };
    };
    const windows = [0.3, 0.7, 1.3, 1.7, 2.3, 2.7].map(measure);

    return {
      windows,
      errors,
      loopStart,
      loopEnd,
      scheduledBoundaries: [cycleOutputSeconds, cycleOutputSeconds * 2],
      outputDurationSeconds: rendered.duration,
    };
  });

  console.info("PRACTICE_RECORDING_LOOP_DSP", JSON.stringify(result));
  await testInfo.attach("practice-recording-loop-dsp", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.outputDurationSeconds).toBeGreaterThan(2.8);
  expect(result.scheduledBoundaries).toEqual([1, 2]);
  expect(result.errors).toEqual([]);
  expect(result.windows).toHaveLength(6);
  for (const [index, window] of result.windows.entries()) {
    const expectedFrequency = index % 2 === 0 ? 220 : 440;
    expect(window.peakAmplitude, `${window.centerSeconds}s signal level`).toBeGreaterThan(0.02);
    expect(window.peakHz, `${window.centerSeconds}s loop section frequency`).toBe(expectedFrequency);
  }
});
