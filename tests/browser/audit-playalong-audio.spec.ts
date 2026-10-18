import { expect, test } from "@playwright/test";
import { configureStudioTestOutput, expectStudioCanvas, settledStudio } from "./studio-helpers";

function variableLength(value: number): number[] {
  const bytes = [value & 0x7f];
  while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

/** Original four-note fixture: right-hand targets at 0/2s, left accompaniment at 0/0.5s. */
function accompanimentMidi(): Buffer {
  const track = (events: number[]) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(events.length);
    return Buffer.concat([Buffer.from("MTrk"), length, Buffer.from(events)]);
  };
  const right = [
    0, 0xff, 0x51, 3, 7, 0xa1, 0x20,
    0, 0x90, 72, 90,
    ...variableLength(1440), 0x80, 72, 0,
    ...variableLength(480), 0x90, 74, 90,
    ...variableLength(480), 0x80, 74, 0,
    0, 0xff, 0x2f, 0,
  ];
  const left = [
    0, 0x91, 36, 80,
    ...variableLength(192), 0x81, 36, 0,
    ...variableLength(288), 0x91, 40, 80,
    ...variableLength(192), 0x81, 40, 0,
    0, 0xff, 0x2f, 0,
  ];
  return Buffer.concat([
    Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 1, 0xe0]),
    track(right), track(left),
  ]);
}

type AudioEvent = { kind: "on" | "off"; voiceId: string; pitch?: number; at: number };
declare global { interface Window { __auditPlayAlongAudio?: AudioEvent[] } }

test("companion notes keep their onsets and owned voices are released when leaving practice", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/?empty=true");
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled();
  await configureStudioTestOutput(page);
  await page.locator("#midi-file").setInputFiles({
    name: "Audit accompaniment.mid", mimeType: "audio/midi", buffer: accompanimentMidi(),
  });
  await expectStudioCanvas(page);
  const snapshot = await settledStudio(page, 0);
  for (const [pitch, hand] of [[36, "left"], [40, "left"], [72, "right"], [74, "right"]] as const) {
    const note = snapshot.result.document!.notes.find(note => note.pitch === pitch)!;
    expect(snapshot.result.fingeringPlan!.assignments.find(a => a.noteId === note.noteId)?.hand).toBe(hand);
  }
  await page.getByRole("button", { name: "Performance", exact: true }).click();

  // Observe the real output without replacing its audio implementation.
  await page.evaluate(async () => {
    const { SynthPerformanceOutput } = await import("/src/audio/output/performanceOutput.ts");
    window.__auditPlayAlongAudio = [];
    const on = SynthPerformanceOutput.prototype.noteOn;
    const off = SynthPerformanceOutput.prototype.noteOff;
    SynthPerformanceOutput.prototype.noteOn = function (...args: Parameters<typeof on>) {
      window.__auditPlayAlongAudio!.push({ kind: "on", voiceId: args[0], pitch: args[1], at: performance.now() });
      return Reflect.apply(on, this, args);
    };
    SynthPerformanceOutput.prototype.noteOff = function (...args: Parameters<typeof off>) {
      window.__auditPlayAlongAudio!.push({ kind: "off", voiceId: args[0], pitch: args[1], at: performance.now() });
      return Reflect.apply(off, this, args);
    };
  });
  await page.getByRole("button", { name: "Play along", exact: true }).click();
  const controls = page.getByLabel("Play along practice controls");
  await controls.getByRole("button", { name: "Right hand", exact: true }).click();
  await expect(controls.getByLabel("Auto-play other hand")).toBeChecked();
  await page.locator('canvas[aria-label="Piano workspace"]').focus();
  await page.keyboard.down("k");
  await expect.poll(() => page.evaluate(() => window.__auditPlayAlongAudio!.filter(e => e.kind === "on" && e.pitch === 40).length)).toBe(1);
  const events = await page.evaluate(() => window.__auditPlayAlongAudio!);
  const first = events.find(e => e.kind === "on" && e.pitch === 36)!;
  const later = events.find(e => e.kind === "on" && e.pitch === 40)!;
  expect(later.at - first.at).toBeGreaterThan(300);
  expect(later.at - first.at).toBeLessThan(1500);
  expect(later.voiceId).not.toBe(first.voiceId);
  expect(later.voiceId).not.toBe("playalong-40");

  await page.getByRole("button", { name: "Performance", exact: true }).click();
  const user = events.find(e => e.kind === "on" && e.pitch === 72)!;
  await expect.poll(() => page.evaluate(id => window.__auditPlayAlongAudio!.some(e => e.kind === "off" && e.voiceId === id), user.voiceId)).toBe(true);
  await page.keyboard.up("k");
  expect(errors).toEqual([]);
});
