import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { SongDocument } from "@handthesia/contracts";
import { loadStudioSong } from "./studio-helpers";
import {
  chooseFormat,
  demuxMedia,
  installOpfsSavePicker,
  inspectNativePlayback,
  openVideoExportModal,
  readOpfsFileSize,
  readOpfsOutput,
  type MediaFormat,
} from "./media-export-helpers";

test.setTimeout(600_000);

async function exportAndVerify(
  page: Page,
  testInfo: TestInfo,
  format: MediaFormat,
  index: number,
  noteStart: number,
  durationSeconds: number,
  preset: "1080p" | "720p",
  width: number,
  height: number,
) {
  await openVideoExportModal(page, preset);
  await chooseFormat(page, format);
  await page.locator("#start-export-btn").click();
  await expect(page.locator("#export-status-text")).toContainText(/completed successfully|Export failed|Export canceled/, { timeout: 180_000 });
  await expect(page.locator("#export-status-text")).toContainText("Export completed successfully");
  await expect(page.locator("#saved-video-file")).toBeVisible();

  const output = await readOpfsOutput(page, index);
  const demuxed = await demuxMedia(output.bytes);
  await testInfo.attach(output.name, { body: output.bytes, contentType: demuxed.mimeType });
  await testInfo.attach(`${format}-demux-metrics.json`, { body: JSON.stringify(demuxed, null, 2), contentType: "application/json" });
  expect(demuxed.mimeType).toContain(format === "mp4" ? "video/mp4" : "video/webm");
  expect(demuxed.width).toBe(width);
  expect(demuxed.height).toBe(height);
  expect(demuxed.videoPackets.length).toBeGreaterThan(100);
  expect(demuxed.audioPackets.length).toBeGreaterThan(10);
  expect(demuxed.videoPackets.every((packet) => packet.bytes > 0 && packet.duration > 0)).toBe(true);
  // WebM SimpleBlock omits duration. Mediabunny reports 0 for the last Opus
  // packet in each cluster; the codec and following timestamp supply its span.
  // Check bytes, continuous timestamps and native decoded audio instead.
  expect(demuxed.audioPackets.every((packet) => packet.bytes > 0 && Number.isFinite(packet.duration) &&
    (format === "webm" ? packet.duration >= 0 : packet.duration > 0))).toBe(true);
  for (let packetIndex = 1; packetIndex < demuxed.audioPackets.length; packetIndex += 1) {
    const delta = demuxed.audioPackets[packetIndex]!.timestamp - demuxed.audioPackets[packetIndex - 1]!.timestamp;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(0.025);
  }
  const videoPackets = [...demuxed.videoPackets].sort((left, right) => left.timestamp - right.timestamp);
  expect(videoPackets[0]!.timestamp).toBeCloseTo(0, 3);
  expect(videoPackets.length).toBe(Math.round(durationSeconds * 30));
  for (let index = 1; index < videoPackets.length; index += 1) {
    expect(videoPackets[index]!.timestamp - videoPackets[index - 1]!.timestamp).toBeCloseTo(1 / 30, 2);
  }
  expect(demuxed.durationSeconds).toBeGreaterThan(durationSeconds - 0.08);
  expect(demuxed.durationSeconds).toBeLessThan(durationSeconds + 0.08);
  expect(demuxed.videoDurationSeconds).toBeGreaterThan(durationSeconds - 0.08);
  expect(demuxed.audioDurationSeconds).toBeGreaterThan(durationSeconds - 0.1);
  const audioPacketDuration = Math.max(...demuxed.audioPackets.map((packet) => packet.duration));
  expect(Math.abs(demuxed.videoDurationSeconds - demuxed.audioDurationSeconds))
    .toBeLessThanOrEqual(1 / 30 + audioPacketDuration + 0.001);
  const native = await inspectNativePlayback(page, output.name, format, output.bytes, noteStart);
  expect(native.width).toBe(width);
  expect(native.height).toBe(height);
  expect(native.duration).toBeGreaterThan(durationSeconds - 0.08);
  expect(native.pixelDifferenceCount).toBeGreaterThan(25);
  expect(native.handRegionDifferenceCount).toBeGreaterThan(25);
  expect(native.audioRms).toBeGreaterThan(1e-5);
  await testInfo.attach(`${format}-decoded-metrics.json`, {
    body: JSON.stringify({ ...demuxed, native: {
      width: native.width, height: native.height, duration: native.duration,
      pixelDifferenceCount: native.pixelDifferenceCount,
      handRegionDifferenceCount: native.handRegionDifferenceCount, audioRms: native.audioRms,
    } }, null, 2), contentType: "application/json",
  });
  for (const [frameName, dataUrl] of [
    [`${format}-before-note.png`, native.beforePngDataUrl],
    [`${format}-during-note.png`, native.duringPngDataUrl],
  ] as const) {
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    await testInfo.attach(frameName, { body: Buffer.from(base64, "base64"), contentType: "image/png" });
  }
  await page.locator("#export-close-btn").click();
  await expect(page.getByRole("dialog", { name: /Export Performance Video/ })).toHaveCount(0);
}

test("real MP4 at 1080p and WebM at 720p demux, decode, seek, move hands, and carry synchronized audio", async ({ page }, testInfo) => {
  await installOpfsSavePicker(page);
  const studio = await loadStudioSong(page);
  const document = studio.result.document as SongDocument;
  expect(document).toBeTruthy();
  const firstNoteStart = Math.min(...document!.notes.map((note) => note.startSeconds));
  const durationSeconds = Math.round((document!.durationSeconds + 2 + 1.5) * 30) / 30;

  await exportAndVerify(page, testInfo, "mp4", 0, firstNoteStart, durationSeconds, "1080p", 1920, 1080);
  await exportAndVerify(page, testInfo, "webm", 1, firstNoteStart, durationSeconds, "720p", 1280, 720);
});

test("closing an active export with Escape cancels the real file writer and leaves no partial file", async ({ page }) => {
  await installOpfsSavePicker(page);
  await loadStudioSong(page);
  await openVideoExportModal(page);
  const mp4Option = page.locator('#export-format-select option[value="mp4"]');
  const format: MediaFormat = await mp4Option.isDisabled() ? "webm" : "mp4";
  await chooseFormat(page, format);
  await page.locator("#start-export-btn").click();
  await expect(page.locator("#cancel-export-btn")).toBeVisible({ timeout: 120_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /Export Performance Video/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeFocused();
  await expect.poll(() => readOpfsFileSize(page, 0)).toBe(0);
});

test("missing WebCodecs disables export with an explicit reason", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "VideoEncoder", { configurable: true, value: undefined });
  });
  await loadStudioSong(page);
  await openVideoExportModal(page);
  await expect(page.locator("#start-export-btn")).toBeDisabled();
  await expect(page.locator("#export-format-capability")).toContainText("WebCodecs VideoEncoder");
});

test("a native file close failure reports error and never reports completed", async ({ page }) => {
  await installOpfsSavePicker(page, true);
  await loadStudioSong(page);
  await openVideoExportModal(page, "720p");
  await chooseFormat(page, "mp4");
  await page.locator("#start-export-btn").click();
  await expect(page.locator("#export-status-text")).toContainText(/completed successfully|Export failed|Export canceled/, { timeout: 180_000 });
  await expect(page.locator("#export-status-text")).toContainText("Injected native file close failure");
  await expect(page.locator("#saved-video-file")).toHaveCount(0);
  await expect(page.locator("#export-status-text")).not.toContainText("completed successfully");
  await expect.poll(() => readOpfsFileSize(page, 0)).toBe(0);
});
