import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { PerformancePlan } from "@handthesia/contracts";
import { createSyntheticStereoSf2 } from "../../apps/client/src/audio/soundfont/testing/syntheticStereoSf2";
import {
  demuxMedia,
  installOpfsSavePicker,
  openVideoExportModal,
  readOpfsOutput,
  type MediaFormat,
} from "./media-export-helpers";
import { loadStudioSong, openStudioInspector } from "./studio-helpers";

test.setTimeout(600_000);

interface StereoProbe {
  durationSeconds: number;
  beforeRms: [number, number];
  duringRms: [number, number];
  channelCorrelation: number;
}

async function renderAndDecodeStereoWav(page: Page) {
  return page.evaluate(async () => {
    const summarize = (
      left: Float32Array,
      right: Float32Array,
      sampleRate: number,
      from: number,
      to: number,
    ) => {
      const start = Math.max(0, Math.round(from * sampleRate));
      const end = Math.min(
        left.length,
        right.length,
        Math.round(to * sampleRate),
      );
      let leftPower = 0;
      let rightPower = 0;
      let product = 0;
      for (let index = start; index < end; index += 1) {
        const l = left[index]!;
        const r = right[index]!;
        leftPower += l * l;
        rightPower += r * r;
        product += l * r;
      }
      const count = Math.max(1, end - start);
      return {
        rms: [Math.sqrt(leftPower / count), Math.sqrt(rightPower / count)] as [
          number,
          number,
        ],
        correlation:
          product / Math.sqrt(Math.max(1e-30, leftPower * rightPower)),
      };
    };
    const estimatePhase = (
      samples: Float32Array,
      sampleRate: number,
      from: number,
      to: number,
      noteStart: number,
      frequency: number,
    ) => {
      const start = Math.max(0, Math.round(from * sampleRate));
      const end = Math.min(samples.length, Math.round(to * sampleRate));
      let sineProjection = 0;
      let cosineProjection = 0;
      for (let index = start; index < end; index += 1) {
        const relativeTime = index / sampleRate - noteStart;
        const angle = 2 * Math.PI * frequency * relativeTime;
        sineProjection += samples[index]! * Math.sin(angle);
        cosineProjection += samples[index]! * Math.cos(angle);
      }
      return Math.atan2(cosineProjection, sineProjection);
    };
    const [
      { getSettings },
      { loadSoundFontAsset },
      { parseSf2Async },
      { renderOfflineAudio },
      { SoundFontSynth },
      { getSoundFontSampleProviderStats },
    ] = await Promise.all([
      import("/src/settings/settingsStore.ts"),
      import("/src/audio/soundfont/soundfontAssetStore.ts"),
      import("/src/audio/soundfont/sf2Parser.ts"),
      import("/src/export/offlineAudioRenderer.ts"),
      import("/src/audio/soundfont/soundfontSynth.ts"),
      import("/src/audio/soundfont/soundfontSampleProvider.ts"),
    ]);
    const assetId = getSettings().soundfontAssetId;
    if (!assetId)
      throw new Error("The synthetic SoundFont asset is not selected.");
    const asset = await loadSoundFontAsset(assetId);
    if (!asset || !(asset.data instanceof Blob))
      throw new Error(
        "The SoundFont store did not return the file-backed Blob.",
      );
    const liveBank = await parseSf2Async(asset.data);
    const offlineBank = await parseSf2Async(asset.data);
    if (liveBank.sampleSource) liveBank.sampleSource.assetId = assetId;
    if (offlineBank.sampleSource) offlineBank.sampleSource.assetId = assetId;
    const liveContext = new AudioContext({ sampleRate: 22_050 });
    const liveSynth = new SoundFontSynth({
      audioContext: liveContext,
      destinationNode: liveContext.destination,
    });
    let audioContext: AudioContext | null = null;
    try {
      liveSynth.loadSoundFont(liveBank);
      await liveSynth.prepareNotes([{ pitch: 69, velocity: 120 }]);
      const afterLivePreparation = getSoundFontSampleProviderStats();
      const performancePlan = {
        schemaVersion: 1,
        kind: "performance",
        planId: "stereo-wave-plan",
        projectId: "stereo-wave-project",
        inputRevision: 0,
        profileId: "default",
        profileRevision: 0,
        engineVersion: "f".repeat(64),
        fingeringPlanId: "stereo-wave-fingering",
        diagnostics: [],
        events: [
          {
            type: "press",
            timeSeconds: 0.12,
            noteId: "stereo-wave-note",
            pitch: 69,
            velocity: 120,
          },
          { type: "release", timeSeconds: 0.55, noteId: "stereo-wave-note" },
        ],
      };
      const rendered = await renderOfflineAudio({
        document: {} as never,
        performancePlan: performancePlan as never,
        soundFont: offlineBank,
        speed: 1,
        startTime: 0,
        durationSeconds: 1.25,
        sampleRate: 22_050,
        volume: 1,
      });
      if (!rendered.wavBlob)
        throw new Error("SoundFont WAV render did not produce a WAV Blob.");
      const afterOfflinePreparation = getSoundFontSampleProviderStats();
      audioContext = new AudioContext({ sampleRate: 22_050 });
      const decoded = await audioContext.decodeAudioData(
        await rendered.wavBlob.arrayBuffer(),
      );
      if (decoded.numberOfChannels !== 2)
        throw new Error(
          `Decoded WAV has ${decoded.numberOfChannels} channel(s).`,
        );
      const left = decoded.getChannelData(0);
      const right = decoded.getChannelData(1);
      const before = summarize(left, right, decoded.sampleRate, 0.02, 0.09);
      const during = summarize(left, right, decoded.sampleRate, 0.22, 0.42);
      const after = summarize(left, right, decoded.sampleRate, 0.95, 1.15);
      const leftPhase = estimatePhase(
        left,
        decoded.sampleRate,
        0.22,
        0.42,
        0.12,
        440,
      );
      const rightPhase = estimatePhase(
        right,
        decoded.sampleRate,
        0.22,
        0.42,
        0.12,
        440,
      );
      const phaseDifference = Math.atan2(
        Math.sin(rightPhase - leftPhase),
        Math.cos(rightPhase - leftPhase),
      );
      const providerStats = getSoundFontSampleProviderStats();
      return {
        sampleCount: offlineBank.sampleSource?.sampleCount ?? null,
        materializedWholeBank: Boolean(offlineBank.rawSampleData),
        wavBytes: rendered.wavBlob.size,
        sampleRate: decoded.sampleRate,
        afterLivePreparation,
        providerStats,
        sharedCache: {
          readsUnchanged:
            afterOfflinePreparation.reads === afterLivePreparation.reads,
          cacheHitsAdded:
            afterOfflinePreparation.cacheHits - afterLivePreparation.cacheHits,
        },
        beforeRms: before.rms,
        duringRms: during.rms,
        duringCorrelation: during.correlation,
        leftPhase,
        rightPhase,
        phaseDifference,
        afterRms: after.rms,
      };
    } finally {
      liveSynth.dispose();
      await liveContext.close();
      await audioContext?.close();
    }
  });
}

async function probeNativeStereoVideo(
  page: Page,
  name: string,
  format: MediaFormat,
  bytes: Buffer,
  beforeSeconds: number,
  duringSeconds: number,
): Promise<StereoProbe> {
  await page.evaluate(() => {
    document.getElementById("stereo-video-file")?.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.id = "stereo-video-file";
    input.style.position = "fixed";
    input.style.left = "-10000px";
    document.body.appendChild(input);
  });
  await page.locator("#stereo-video-file").setInputFiles({
    name,
    mimeType: format === "mp4" ? "video/mp4" : "video/webm",
    buffer: bytes,
  });

  return page.evaluate(
    async ({ beforeTime, duringTime }) => {
      const file =
        document.querySelector<HTMLInputElement>("#stereo-video-file")
          ?.files?.[0];
      if (!file)
        throw new Error(
          "Native media probe did not receive the exported file.",
        );
      const video = document.createElement("video");
      video.preload = "auto";
      video.playsInline = true;
      const objectUrl = URL.createObjectURL(file);
      video.src = objectUrl;
      document.body.appendChild(video);
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => resolve(), {
          once: true,
        });
        video.addEventListener(
          "error",
          () =>
            reject(new Error(`Native ${file.type} metadata decode failed.`)),
          { once: true },
        );
      });
      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          resolve();
          return;
        }
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        video.addEventListener(
          "error",
          () => reject(new Error(`Native ${file.type} frame decode failed.`)),
          { once: true },
        );
      });

      const audioContext = new AudioContext();
      const source = audioContext.createMediaElementSource(video);
      const splitter = audioContext.createChannelSplitter(2);
      const leftAnalyser = audioContext.createAnalyser();
      const rightAnalyser = audioContext.createAnalyser();
      leftAnalyser.fftSize = 4096;
      rightAnalyser.fftSize = 4096;
      leftAnalyser.smoothingTimeConstant = 0;
      rightAnalyser.smoothingTimeConstant = 0;
      source.connect(splitter);
      splitter.connect(leftAnalyser, 0);
      splitter.connect(rightAnalyser, 1);
      leftAnalyser.connect(audioContext.destination);
      rightAnalyser.connect(audioContext.destination);
      await audioContext.resume();

      const sampleAt = async (time: number) => {
        video.pause();
        const target = Math.max(0, Math.min(video.duration - 0.08, time));
        if (Math.abs(video.currentTime - target) > 0.01) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () =>
                reject(
                  new Error(`Native ${file.type} seek timed out at ${target}.`),
                ),
              15_000,
            );
            video.addEventListener(
              "seeked",
              () => {
                clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
            video.currentTime = target;
          });
        }
        await video.play();
        await new Promise((resolve) => setTimeout(resolve, 90));
        video.pause();
        const left = new Float32Array(leftAnalyser.fftSize);
        const right = new Float32Array(rightAnalyser.fftSize);
        leftAnalyser.getFloatTimeDomainData(left);
        rightAnalyser.getFloatTimeDomainData(right);
        let leftPower = 0;
        let rightPower = 0;
        let product = 0;
        for (let index = 0; index < left.length; index += 1) {
          leftPower += left[index]! * left[index]!;
          rightPower += right[index]! * right[index]!;
          product += left[index]! * right[index]!;
        }
        const count = Math.max(1, left.length);
        return {
          rms: [
            Math.sqrt(leftPower / count),
            Math.sqrt(rightPower / count),
          ] as [number, number],
          correlation:
            product / Math.sqrt(Math.max(1e-30, leftPower * rightPower)),
        };
      };

      try {
        const before = await sampleAt(beforeTime);
        const during = await sampleAt(duringTime);
        return {
          durationSeconds: video.duration,
          beforeRms: before.rms,
          duringRms: during.rms,
          channelCorrelation: during.correlation,
        };
      } finally {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(objectUrl);
        await audioContext.close();
        video.remove();
      }
    },
    { beforeTime: beforeSeconds, duringTime: duringSeconds },
  );
}

test("file-backed linked stereo SF2 stays stereo through WAV, MP4, and WebM export", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await installOpfsSavePicker(page);
  const studio = await loadStudioSong(page);
  const bankBytes = Buffer.from(createSyntheticStereoSf2());
  const expectedHash = createHash("sha256").update(bankBytes).digest("hex");

  await page
    .getByRole("button", { name: "Open preferences", exact: true })
    .click();
  await page.locator("#settings-sound-output").selectOption("soundfont");
  await page.locator('input[type="file"][accept=".sf2"]').setInputFiles({
    name: "Synthetic Stereo SF2.sf2",
    mimeType: "audio/sf2",
    buffer: bankBytes,
  });
  await expect(page.locator("#settings-soundfont-select")).toBeVisible();
  const assetId = await page.locator("#settings-soundfont-select").inputValue();
  expect(assetId).toBe(expectedHash);
  await page.getByRole("button", { name: "Close" }).click();
  await openStudioInspector(page, "Audio");
  await expect(
    page.getByText("Active output: Local SoundFont", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });

  const wav = await renderAndDecodeStereoWav(page);
  expect(wav.sampleCount).toBeGreaterThan(0);
  expect(wav.materializedWholeBank).toBe(false);
  expect(wav.wavBytes).toBeGreaterThan(44);
  expect(wav.providerStats.decodedBytes).toBeLessThanOrEqual(
    wav.providerStats.budgetBytes,
  );
  expect(wav.providerStats.pinnedBytes).toBeLessThanOrEqual(
    wav.providerStats.decodedBytes,
  );
  expect(wav.sharedCache.readsUnchanged).toBe(true);
  expect(wav.sharedCache.cacheHitsAdded).toBeGreaterThan(0);
  expect(Math.max(...wav.beforeRms)).toBeLessThan(1e-4);
  expect(Math.min(...wav.duringRms)).toBeGreaterThan(1e-3);
  expect(Math.abs(wav.duringCorrelation)).toBeLessThan(0.55);
  expect(Math.abs(wav.leftPhase)).toBeLessThan(0.25);
  expect(Math.abs(wav.rightPhase - Math.PI / 2)).toBeLessThan(0.25);
  expect(Math.abs(wav.phaseDifference - Math.PI / 2)).toBeLessThan(0.25);
  expect(Math.max(...wav.afterRms)).toBeLessThan(
    Math.min(...wav.duringRms) * 0.15,
  );

  const plan = studio.result.performancePlan as PerformancePlan;
  const firstPress = plan.events.find((event) => event.type === "press");
  if (!firstPress || firstPress.type !== "press")
    throw new Error("The studio MIDI fixture has no performance note.");
  const noteRelease = plan.events.find(
    (event) => event.type === "release" && event.noteId === firstPress.noteId,
  );
  if (!noteRelease || noteRelease.type !== "release")
    throw new Error("The first performance note has no release event.");
  const noteProbeOffset = Math.max(
    0.04,
    Math.min(0.12, (noteRelease.timeSeconds - firstPress.timeSeconds) / 2),
  );
  const beforeVideoTime = Math.max(0.15, 2 + firstPress.timeSeconds - 0.25);
  const duringVideoTime = 2 + firstPress.timeSeconds + noteProbeOffset;
  const nativeResults: Record<string, StereoProbe> = {};
  let outputIndex = 0;

  for (const format of ["mp4", "webm"] as const) {
    await openVideoExportModal(page, "720p");
    const option = page.locator(
      `#export-format-select option[value="${format}"]`,
    );
    if (await option.isDisabled()) {
      await page.locator("#export-close-btn").click();
      continue;
    }
    await page.locator("#export-format-select").selectOption(format);
    await page.locator("#export-audio-checkbox").check();
    await page.locator("#export-audio-source-select").selectOption("soundfont");
    await expect(page.locator("#export-audio-source-select")).toHaveValue(
      "soundfont",
    );
    await expect(page.locator("#start-export-btn")).toBeEnabled();
    await page.locator("#start-export-btn").click();
    await expect(page.locator("#export-status-text")).toContainText(
      /Export completed successfully|Export failed|Export canceled/,
      { timeout: 240_000 },
    );
    await expect(page.locator("#export-status-text")).toContainText(
      "Export completed successfully",
    );
    const output = await readOpfsOutput(page, outputIndex++);
    const media = await demuxMedia(output.bytes);
    expect(media.mimeType).toContain(
      format === "mp4" ? "video/mp4" : "video/webm",
    );
    expect(media.audioPackets.length).toBeGreaterThan(10);
    expect(media.audioPackets.some((packet) => packet.bytes > 0)).toBe(true);
    const native = await probeNativeStereoVideo(
      page,
      output.name,
      format,
      output.bytes,
      beforeVideoTime,
      duringVideoTime,
    );
    expect(native.durationSeconds).toBeGreaterThan(duringVideoTime + 0.2);
    expect(Math.max(...native.beforeRms)).toBeLessThan(
      Math.min(...native.duringRms) * 0.1,
    );
    expect(Math.min(...native.duringRms)).toBeGreaterThan(1e-5);
    expect(Math.abs(native.channelCorrelation)).toBeLessThan(0.75);
    nativeResults[format] = native;
    await page.locator("#export-close-btn").click();
  }

  if (Object.keys(nativeResults).length === 0) {
    test.skip(
      true,
      "Neither MP4 nor WebM audio encoding is available in this browser.",
    );
  }
  expect(pageErrors).toEqual([]);
  await testInfo.attach("soundfont-stereo-export-metrics.json", {
    body: JSON.stringify(
      {
        wav,
        nativeResults,
        assetId,
        firstPress: firstPress.timeSeconds,
        noteProbeOffset,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
