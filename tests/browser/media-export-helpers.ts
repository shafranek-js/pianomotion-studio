import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { expect, type Page } from "@playwright/test";

export type MediaFormat = "mp4" | "webm";

export interface DemuxedMediaSummary {
  mimeType: string;
  durationSeconds: number;
  videoDurationSeconds: number;
  audioDurationSeconds: number;
  width: number;
  height: number;
  videoPackets: Array<{ timestamp: number; duration: number; bytes: number }>;
  audioPackets: Array<{ timestamp: number; duration: number; bytes: number }>;
}

const exportPresetByPage = new WeakMap<Page, "1080p" | "720p">();

/** Use a real Origin Private File System file and its native writable stream. */
export async function installOpfsSavePicker(page: Page, failClose = false): Promise<void> {
  await page.addInitScript((rejectClose) => {
    const state = { names: [] as string[], failedPickerCalls: 0 };
    (window as Window & { __mediaExportOpfsState?: typeof state }).__mediaExportOpfsState = state;
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async (options: { suggestedName?: string }) => {
        const root = await navigator.storage.getDirectory();
        const name = options.suggestedName ?? `video-${state.names.length + 1}.webm`;
        state.names.push(name);
        const handle = await root.getFileHandle(name, { create: true });
        if (!rejectClose) return handle;
        return {
          name,
          async createWritable() {
            const writer = await handle.createWritable();
            return {
              write: (data: FileSystemWriteChunkType) => writer.write(data),
              close: async () => { throw new Error("Injected native file close failure"); },
              abort: (reason?: unknown) => writer.abort(reason),
            };
          },
        };
      },
    });
  }, failClose);
}

export async function openVideoExportModal(page: Page, preset: "1080p" | "720p" = "1080p"): Promise<void> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const item = page.getByRole("menuitem", { name: "Performance video (.mp4 / .webm)", exact: true });
  await expect(item).toBeEnabled();
  await item.click();
  await expect(page.getByRole("dialog", { name: /Export Performance Video/ })).toBeVisible();
  await expect(page.locator("#export-format-capability")).not.toContainText("Checking encoder support", { timeout: 90_000 });
  const resolution = page.locator("#export-resolution-select");
  const capability = page.locator("#export-format-capability");
  const previousPreset = exportPresetByPage.get(page);
  const openedPreset = previousPreset ?? "1080p";
  const openedDimensions = openedPreset === "1080p" ? "1920 × 1080" : "1280 × 720";
  // The first opening verifies the product default; later openings verify the saved choice.
  await expect(resolution).toHaveValue(openedPreset);
  await expect(capability).toContainText(`${openedDimensions} at 30 FPS`, { timeout: 90_000 });
  if (preset !== openedPreset) await resolution.selectOption(preset);
  await page.locator("#export-fps-select").selectOption("30");
  const dimensions = preset === "1080p" ? "1920 × 1080" : "1280 × 720";
  await expect(capability).toContainText(`${dimensions} at 30 FPS`, { timeout: 90_000 });
  exportPresetByPage.set(page, preset);
}

export async function chooseFormat(page: Page, format: MediaFormat): Promise<void> {
  const option = page.locator(`#export-format-select option[value="${format}"]`);
  await expect(option).toBeAttached();
  await expect(option).not.toBeDisabled();
  await page.locator("#export-format-select").selectOption(format);
  await expect(page.locator("#export-audio-checkbox")).toBeChecked();
  await page.locator("#export-audio-source-select").selectOption("synth");
  await expect(page.locator("#start-export-btn")).toBeEnabled();
}

export async function readOpfsOutput(page: Page, index: number): Promise<{ name: string; bytes: Buffer }> {
  const saved = await page.evaluate(async (fileIndex) => {
    const state = (window as Window & { __mediaExportOpfsState?: { names: string[] } }).__mediaExportOpfsState;
    const name = state?.names[fileIndex];
    if (!name) throw new Error(`No OPFS output was opened at index ${fileIndex}.`);
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name);
    const file = await handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
    }
    return { name, size: file.size, base64: btoa(binary) };
  }, index);
  const bytes = Buffer.from(saved.base64, "base64");
  expect(bytes.byteLength).toBe(saved.size);
  expect(bytes.byteLength).toBeGreaterThan(0);
  return { name: saved.name, bytes };
}

export async function readOpfsFileSize(page: Page, index: number): Promise<number> {
  return page.evaluate(async (fileIndex) => {
    const state = (window as Window & { __mediaExportOpfsState?: { names: string[] } }).__mediaExportOpfsState;
    const name = state?.names[fileIndex];
    if (!name) throw new Error(`No OPFS output was opened at index ${fileIndex}.`);
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name);
    return (await handle.getFile()).size;
  }, index);
}

export async function demuxMedia(bytes: Buffer): Promise<DemuxedMediaSummary> {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack) throw new Error("Muxed output has no video track.");
    if (!audioTrack) throw new Error("Muxed output has no audio track.");
    const [mimeType, durationSeconds, videoDurationSeconds, audioDurationSeconds, width, height] = await Promise.all([
      input.getMimeType(),
      input.computeDuration([videoTrack, audioTrack]),
      videoTrack.computeDuration(),
      audioTrack.computeDuration(),
      videoTrack.getCodedWidth(),
      videoTrack.getCodedHeight(),
    ]);
    const videoPackets: DemuxedMediaSummary["videoPackets"] = [];
    const audioPackets: DemuxedMediaSummary["audioPackets"] = [];
    for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
      videoPackets.push({ timestamp: packet.timestamp, duration: packet.duration, bytes: packet.byteLength });
    }
    for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
      audioPackets.push({ timestamp: packet.timestamp, duration: packet.duration, bytes: packet.byteLength });
    }
    return { mimeType, durationSeconds, videoDurationSeconds, audioDurationSeconds, width, height, videoPackets, audioPackets };
  } finally {
    input.dispose();
  }
}

export async function inspectNativePlayback(
  page: Page,
  name: string,
  format: MediaFormat,
  bytes: Buffer,
  firstNoteStartSeconds: number,
): Promise<{
  width: number;
  height: number;
  duration: number;
  pixelDifferenceCount: number;
  handRegionDifferenceCount: number;
  audioRms: number;
  beforePngDataUrl: string;
  duringPngDataUrl: string;
}> {
  await page.evaluate(() => {
    document.getElementById("media-export-native-decode-file")?.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.id = "media-export-native-decode-file";
    input.style.position = "fixed";
    input.style.left = "-10000px";
    document.body.appendChild(input);
  });
  await page.locator("#media-export-native-decode-file").setInputFiles({
    name,
    mimeType: format === "mp4" ? "video/mp4" : "video/webm",
    buffer: bytes,
  });
  return page.evaluate(async (noteStart) => {
    const input = document.querySelector<HTMLInputElement>("#media-export-native-decode-file");
    const file = input?.files?.[0];
    if (!file) throw new Error("Native playback probe did not receive the saved video file.");
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    video.muted = true;
    video.src = URL.createObjectURL(file);
    document.body.appendChild(video);
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error(`Native browser video decode failed (${video.error?.code ?? "unknown"}).`)), { once: true });
    });
    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) { resolve(); return; }
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Native browser could not decode the first video frame.")), { once: true });
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Native video pixel probe could not create a 2D canvas.");
    const seek = async (timeSeconds: number) => {
      const target = Math.max(0, Math.min(video.duration - 0.05, timeSeconds));
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Native video seek timed out at ${target.toFixed(3)} seconds.`)), 20_000);
        const onSeeked = () => { clearTimeout(timeout); resolve(); };
        video.addEventListener("seeked", onSeeked, { once: true });
        video.currentTime = target;
      });
      context.drawImage(video, 0, 0);
      return {
        pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
        pngDataUrl: canvas.toDataURL("image/png"),
      };
    };
    const beforeFrame = await seek(Math.max(0.05, 2 + noteStart - 0.3));
    const duringFrame = await seek(2 + noteStart + 0.16);
    const before = beforeFrame.pixels;
    const during = duringFrame.pixels;
    let pixelDifferenceCount = 0;
    for (let index = 0; index < before.length; index += 4 * 17) {
      const distance = Math.abs(before[index]! - during[index]!) +
        Math.abs(before[index + 1]! - during[index + 1]!) +
        Math.abs(before[index + 2]! - during[index + 2]!);
      if (distance > 24) pixelDifferenceCount += 1;
    }
    // Match PianoScene.computeBottomLayout's hand area: it sits below the keyboard,
    // outside the falling-note viewport, so this motion signal cannot come from notes.
    const whiteKeyWidth = canvas.width / 52;
    const budget = Math.max(0, canvas.height * 0.5);
    const desiredKeyboardHeight = Math.max(1, Math.round(whiteKeyWidth * 5.6));
    const desiredHandHeight = Math.max(
      Math.round(whiteKeyWidth * 7),
      Math.min(120, Math.round(canvas.height * 0.2)),
    );
    const desiredTotal = desiredKeyboardHeight + desiredHandHeight;
    const verticalScale = desiredTotal > budget && desiredTotal > 0 ? budget / desiredTotal : 1;
    const keyboardHeight = Math.max(0, Math.round(desiredKeyboardHeight * verticalScale));
    const handHeight = Math.max(0, Math.min(
      Math.round(desiredHandHeight * verticalScale),
      Math.floor(budget) - keyboardHeight,
    ));
    const handRegionStart = Math.max(0, canvas.height - handHeight);
    let handRegionDifferenceCount = 0;
    for (let y = handRegionStart; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 17) {
        const index = (y * canvas.width + x) * 4;
        const distance = Math.abs(before[index]! - during[index]!) +
          Math.abs(before[index + 1]! - during[index + 1]!) +
          Math.abs(before[index + 2]! - during[index + 2]!);
        if (distance > 24) handRegionDifferenceCount += 1;
      }
    }
    video.muted = false;
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    const source = audioContext.createMediaElementSource(video);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    await audioContext.resume();
    await new Promise<void>((resolve, reject) => {
      const target = Math.max(0, Math.min(video.duration - 0.7, 2 + noteStart - 0.05));
      const timeout = setTimeout(() => reject(new Error("Native audio probe seek timed out.")), 20_000);
      video.addEventListener("seeked", () => { clearTimeout(timeout); resolve(); }, { once: true });
      video.currentTime = target;
    });
    await video.play();
    const samples = new Float32Array(analyser.fftSize);
    let audioRms = 0;
    for (let probe = 0; probe < 10; probe += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      analyser.getFloatTimeDomainData(samples);
      audioRms = Math.max(audioRms, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length));
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    const duration = video.duration;
    video.pause();
    await audioContext.close();
    URL.revokeObjectURL(video.src);
    video.remove();
    return {
      width,
      height,
      duration,
      pixelDifferenceCount,
      handRegionDifferenceCount,
      audioRms,
      beforePngDataUrl: beforeFrame.pngDataUrl,
      duringPngDataUrl: duringFrame.pngDataUrl,
    };
  }, firstNoteStartSeconds);
}
