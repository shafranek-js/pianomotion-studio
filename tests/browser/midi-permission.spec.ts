import { expect, test } from "@playwright/test";
import { loadStudioSong } from "./studio-helpers";

test("does not request Web MIDI access until the user explicitly connects", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as Window & { __midiRequests?: number };
    state.__midiRequests = 0;
    const access = {
      inputs: new Map(),
      outputs: new Map(),
      onstatechange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      value: async () => {
        state.__midiRequests = (state.__midiRequests ?? 0) + 1;
        return access;
      },
    });
  });

  await loadStudioSong(page);
  expect(await page.evaluate(() => (window as Window & { __midiRequests?: number }).__midiRequests)).toBe(0);

  await page.getByRole("button", { name: "Play along", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect MIDI", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __midiRequests?: number }).__midiRequests)).toBe(0);

  await page.getByRole("button", { name: "Connect MIDI", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __midiRequests?: number }).__midiRequests)).toBe(1);
});
