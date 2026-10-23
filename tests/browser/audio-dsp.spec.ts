import { expect, test } from "@playwright/test";

test("real AudioWorklet tone/marker accuracy and offline SF2 mode/polyphony", async ({ page }, testInfo) => {
  const productionCsp = "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval' 'unsafe-eval'; worker-src 'self' blob:; child-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none';";
  let cspWasInjected = false;
  await page.route((url) => url.pathname === "/", async (route) => {
    const response = await route.fetch();
    const originalHtml = await response.text();
    expect(originalHtml).toContain("<head>");
    const html = originalHtml.replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="${productionCsp}">`,
    );
    cspWasInjected = html !== originalHtml;
    await route.fulfill({ response, body: html });
  });
  await page.goto("/");
  expect(cspWasInjected, "production CSP route must intercept the test origin before loading DSP modules").toBe(true);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute("content", productionCsp);
  const result = await page.evaluate(async () => {
    const { renderRecordingWithSignalsmith } = await import("/src/audio/recording/timeStretch.ts");
    const { renderOfflineAudio } = await import("/src/export/offlineAudioRenderer.ts");

    const sampleRate = 48_000;
    const recordingLength = sampleRate * 4;
    const tone = new Float32Array(recordingLength);
    const marker = new Float32Array(recordingLength);
    for (let i = 0; i < recordingLength; i += 1) {
      tone[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }
    // A broadband, channel-isolated marker makes the output position measurable
    // without disturbing the continuous reference tone on the other channel.
    for (let i = Math.round(0.495 * sampleRate); i < Math.round(0.505 * sampleRate); i += 1) {
      marker[i] = ((i * 16807) % 32768) / 32768 - 0.5;
    }
    const recording = {
      buffer: {
        numberOfChannels: 2,
        sampleRate,
        length: recordingLength,
      duration: 4,
        getChannelData(channel: number) { return channel === 0 ? tone : marker; },
      } as unknown as AudioBuffer,
      durationSeconds: 4,
      sampleRate,
      numberOfChannels: 2,
      peaks: new Float32Array(0),
    };

    const stretchMetrics: Array<{
      speed: number;
      cents: number;
      pitchWindows: Array<{ from: number; to: number; cents: number; rms: number }>;
      expectedMarker: number;
      measuredMarker: number;
    }> = [];
    for (const speed of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]) {
      const rendered = await renderRecordingWithSignalsmith({
        recording,
        startTimeSeconds: 0,
        offsetSeconds: 0,
        speed,
        durationSeconds: 2.5,
        sampleRate,
      });
      const toneData = rendered.getChannelData(0);
      // Fixed steady-state output windows stay clear of worklet startup and
      // map inside the 4 s reference tone at every UI-supported speed. At 2x,
      // use the same-length region shifted earlier to keep input under 4 s.
      const pitchWindows = (speed === 2
        ? [{ from: 0.5, to: 1 }, { from: 1, to: 1.5 }]
        : [{ from: 1, to: 1.5 }, { from: 1.5, to: 2 }]
      ).map(({ from, to }) => {
        const toneFrom = Math.round(from * sampleRate);
        const toneTo = Math.round(to * sampleRate);
        let mean = 0;
        for (let i = toneFrom; i < toneTo; i += 1) mean += toneData[i]!;
        mean /= toneTo - toneFrom;
        const correlation = (lag: number) => {
          let dot = 0;
          let leftEnergy = 0;
          let rightEnergy = 0;
          for (let i = toneFrom; i < toneTo - lag; i += 1) {
            const left = toneData[i]! - mean;
            const right = toneData[i + lag]! - mean;
            dot += left * right;
            leftEnergy += left * left;
            rightEnergy += right * right;
          }
          return dot / Math.sqrt(Math.max(1e-20, leftEnergy * rightEnergy));
        };
        const minimumLag = Math.floor(sampleRate / 460);
        const maximumLag = Math.ceil(sampleRate / 420);
        let bestLag = minimumLag;
        for (let lag = minimumLag + 1; lag <= maximumLag; lag += 1) {
          if (correlation(lag) > correlation(bestLag)) bestLag = lag;
        }
        const previous = correlation(bestLag - 1);
        const peak = correlation(bestLag);
        const next = correlation(bestLag + 1);
        const denominator = previous - 2 * peak + next;
        const lagCorrection = Math.abs(denominator) < 1e-10 ? 0 : 0.5 * (previous - next) / denominator;
        const measuredHz = sampleRate / (bestLag + lagCorrection);
        let signalEnergy = 0;
        for (let i = toneFrom; i < toneTo; i += 1) signalEnergy += toneData[i]! * toneData[i]!;
        return {
          from,
          to,
          cents: 1200 * Math.log2(measuredHz / 440),
          rms: Math.sqrt(signalEnergy / Math.max(1, toneTo - toneFrom)),
        };
      });

      const markerData = rendered.getChannelData(1);
      const windowFrames = Math.round(0.01 * sampleRate);
      const hopFrames = Math.max(1, Math.round(0.0025 * sampleRate));
      let peakEnergy = -1;
      let peakFrame = 0;
      for (let start = 0; start + windowFrames <= markerData.length; start += hopFrames) {
        let energy = 0;
        for (let i = start; i < start + windowFrames; i += 1) energy += markerData[i]! * markerData[i]!;
        if (energy > peakEnergy) {
          peakEnergy = energy;
          peakFrame = start + Math.floor(windowFrames / 2);
        }
      }
      stretchMetrics.push({
        speed,
        cents: pitchWindows[0]!.cents,
        pitchWindows,
        expectedMarker: 0.5 / speed,
        measuredMarker: peakFrame / sampleRate,
      });
    }

    const makeBank = (sampleModes: 0 | 1 | 3) => {
      const bankRate = 22_050;
      const rawSampleData = new Int16Array(bankRate);
      // Loop region is deliberately quiet; the one-shot tail is much louder.
      // Mode 3 must stay in the quiet loop while sustain holds, then enter the
      // loud tail only when sustain is actually released.
      for (let i = 0; i < rawSampleData.length; i += 1) {
        rawSampleData[i] = i >= Math.round(0.3 * bankRate) ? 22_000 : 2_500;
      }
      return {
        header: { name: `Synthetic mode ${sampleModes}`, versionMajor: 2, versionMinor: 4 },
        presets: [{
          name: "Synthetic",
          presetNumber: 0,
          bankNumber: 0,
          zones: [{
            keyRange: [60, 60],
            velRange: [1, 127],
            sampleIndex: 0,
            rootKey: 60,
            attackSeconds: 0.002,
            releaseSeconds: 0.3,
            sampleModes,
          }],
        }],
        samples: [{
          name: "quiet-loop-loud-tail",
          start: 0,
          end: rawSampleData.length,
          loopStart: Math.round(0.1 * bankRate),
          loopEnd: Math.round(0.3 * bankRate),
          sampleRate: bankRate,
          originalPitch: 60,
          pitchCorrection: 0,
          sampleType: 1,
        }],
        rawSampleData,
      };
    };

    const doc = {
      schemaVersion: 1,
      projectId: "audio-dsp-test",
      revision: 0,
      title: "audio-dsp-test",
      durationSeconds: 4,
      tracks: [{ trackId: "track", instrumentIndex: 0, name: "Piano", program: 0, hand: null }],
      notes: [],
      tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500_000, eventOrdinal: 0 }],
      pedalControls: [],
    };
    const makePlan = (events: unknown[]) => ({
      schemaVersion: 1,
      projectId: "audio-dsp-test",
      inputRevision: 0,
      profileId: "default",
      profileRevision: 0,
      engineVersion: "0".repeat(64),
      planId: "audio-dsp-plan",
      kind: "performance",
      fingeringPlanId: "audio-dsp-fingering",
      events,
      diagnostics: [],
    });
    const windowRms = (data: Float32Array, from: number, to: number, rate: number) => {
      const first = Math.round(from * rate);
      const last = Math.min(data.length, Math.round(to * rate));
      let sum = 0;
      for (let i = first; i < last; i += 1) sum += data[i]! * data[i]!;
      return Math.sqrt(sum / Math.max(1, last - first));
    };
    const renderMode = async (sampleModes: 0 | 1 | 3) => {
      const performancePlan = makePlan([
        { type: "press", timeSeconds: 0, noteId: "held", pitch: 60, velocity: 120 },
        { type: "pedal", timeSeconds: 0.1, controller: 64, value: 127 },
        { type: "release", timeSeconds: 0.3, noteId: "held" },
        { type: "pedal", timeSeconds: 0.8, controller: 64, value: 0 },
      ]);
      const rendered = await renderOfflineAudio({
        document: doc as never,
        performancePlan: performancePlan as never,
        soundFont: makeBank(sampleModes) as never,
        speed: 1,
        startTime: 0,
        durationSeconds: 1.4,
        sampleRate: 22_050,
        volume: 1,
      });
      return rendered.audioBuffer.getChannelData(0);
    };
    const mode0 = await renderMode(0);
    const mode1 = await renderMode(1);
    const mode3 = await renderMode(3);
    const modeMetrics = {
      mode0EarlyTail: windowRms(mode0, 0.55, 0.65, 22_050),
      mode0PreTail: windowRms(mode0, 0.15, 0.25, 22_050),
      mode1EarlyLoop: windowRms(mode1, 0.55, 0.65, 22_050),
      mode3HeldLoop: windowRms(mode3, 0.55, 0.65, 22_050),
      mode3ReleasedTail: windowRms(mode3, 1.0, 1.1, 22_050),
      mode1ReleasedLoop: windowRms(mode1, 1.0, 1.1, 22_050),
    };

    const sequentialEvents: unknown[] = [];
    for (let note = 0; note < 100; note += 1) {
      const start = note * 0.03;
      sequentialEvents.push({ type: "press", timeSeconds: start, noteId: `n${note}`, pitch: 60, velocity: 110 });
      sequentialEvents.push({ type: "release", timeSeconds: start + 0.015, noteId: `n${note}` });
    }
    const sequentialPlan = makePlan(sequentialEvents);
    const sequentialBank = makeBank(1);
    sequentialBank.presets[0]!.zones[0]!.releaseSeconds = 0.02;
    const sequential = await renderOfflineAudio({
      document: doc as never,
      performancePlan: sequentialPlan as never,
      soundFont: sequentialBank as never,
      speed: 1,
      startTime: 0,
      durationSeconds: 3.1,
      sampleRate: 22_050,
      volume: 1,
    });
    const output = sequential.audioBuffer.getChannelData(0);
    const onsetPeaks = Array.from({ length: 100 }, (_, note) => {
      const start = Math.round((note * 0.03 + 0.004) * 22_050);
      const end = Math.min(output.length, start + Math.round(0.01 * 22_050));
      let peak = 0;
      for (let i = start; i < end; i += 1) peak = Math.max(peak, Math.abs(output[i]!));
      return peak;
    });

    return { stretchMetrics, modeMetrics, onsetPeaks };
  });

  console.info("AUDIO_DSP_METRICS", JSON.stringify(result));
  await testInfo.attach("audio-dsp-metrics", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });

  expect(result.stretchMetrics).toHaveLength(7);
  for (const metric of result.stretchMetrics) {
    for (const window of metric.pitchWindows) {
      expect(window.rms, `${metric.speed}x steady tone RMS in ${window.from}-${window.to}s`).toBeGreaterThan(0.01);
      expect(Math.abs(window.cents), `${metric.speed}x pitch error ${window.cents} cents in ${window.from}-${window.to}s`)
        .toBeLessThanOrEqual(5);
    }
    expect(
      Math.abs(metric.measuredMarker - metric.expectedMarker),
      `${metric.speed}x marker error ${metric.measuredMarker - metric.expectedMarker} seconds`,
    ).toBeLessThanOrEqual(0.02);
  }

  expect(result.modeMetrics.mode0EarlyTail).toBeGreaterThan(result.modeMetrics.mode0PreTail * 2);
  expect(result.modeMetrics.mode3HeldLoop).toBeCloseTo(result.modeMetrics.mode1EarlyLoop, 1);
  expect(result.modeMetrics.mode3ReleasedTail).toBeGreaterThan(result.modeMetrics.mode1ReleasedLoop * 2);
  expect(result.onsetPeaks.every((peak) => peak > 0.01)).toBe(true);
});
