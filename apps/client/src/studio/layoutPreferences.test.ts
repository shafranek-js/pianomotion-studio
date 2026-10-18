import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STUDIO_LAYOUT_PREFERENCES,
  loadStudioLayoutPreferences,
  sanitizeStudioLayoutPreferences,
  saveStudioLayoutPreferences,
  STUDIO_LAYOUT_DB_KEY,
} from "./layoutPreferences.ts";
import { normalizeStudioView } from "./types.ts";

const { getDbSetting, saveDbSetting } = vi.hoisted(() => ({
  getDbSetting: vi.fn(),
  saveDbSetting: vi.fn(),
}));

vi.mock("../storage/index.ts", () => ({ getDbSetting, saveDbSetting }));

describe("studio layout preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbSetting.mockResolvedValue(null);
    saveDbSetting.mockResolvedValue(undefined);
  });

  it("sanitizes persisted values and clamps widths and split ratio", () => {
    expect(sanitizeStudioLayoutPreferences({
      activePanel: "inspector",
      pinnedSide: "left",
      leftWidth: 900,
      rightWidth: 12,
      splitRatio: 0.98,
      inspectorTab: "audio",
      focusMode: true,
    })).toEqual({
      activePanel: "inspector",
      pinnedSide: "right",
      leftWidth: 400,
      rightWidth: 300,
      splitRatio: 0.75,
      inspectorTab: "audio",
      focusMode: true,
    });
  });

  it("falls back to defaults for malformed or unknown fields", () => {
    expect(sanitizeStudioLayoutPreferences({ activePanel: "unknown", inspectorTab: "midi", leftWidth: NaN }))
      .toEqual(DEFAULT_STUDIO_LAYOUT_PREFERENCES);
    expect(sanitizeStudioLayoutPreferences(null)).toEqual(DEFAULT_STUDIO_LAYOUT_PREFERENCES);
  });

  it("maps legacy split view records to the supported performance view", () => {
    expect(normalizeStudioView("split")).toBe("performance");
    expect(normalizeStudioView("editor")).toBe("editor");
    expect(normalizeStudioView("unknown")).toBe("performance");
  });

  it("keeps a pinned panel on its assigned side when loading an older mismatched layout", () => {
    expect(sanitizeStudioLayoutPreferences({ activePanel: "inspector", pinnedSide: "left" }).pinnedSide)
      .toBe("right");
    expect(sanitizeStudioLayoutPreferences({ activePanel: "projects", pinnedSide: "right" }).pinnedSide)
      .toBe("left");
    expect(sanitizeStudioLayoutPreferences({ activePanel: "practice", pinnedSide: "left" }).pinnedSide)
      .toBe("right");
  });

  it("restores Practice as a supported right-side panel", () => {
    expect(sanitizeStudioLayoutPreferences({ activePanel: "practice", pinnedSide: "right" }))
      .toMatchObject({ activePanel: "practice", pinnedSide: "right" });
  });

  it("loads from the dedicated IndexedDB setting key", async () => {
    getDbSetting.mockResolvedValue({ activePanel: "projects", leftWidth: 350 });
    await expect(loadStudioLayoutPreferences()).resolves.toMatchObject({
      activePanel: "projects",
      leftWidth: 350,
      pinnedSide: null,
    });
    expect(getDbSetting).toHaveBeenCalledWith(STUDIO_LAYOUT_DB_KEY);
  });

  it("serializes and sanitizes queued writes", async () => {
    let releaseFirst!: () => void;
    saveDbSetting.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    const first = saveStudioLayoutPreferences({ leftWidth: 300 });
    const second = saveStudioLayoutPreferences({ leftWidth: 390, focusMode: true });

    await vi.waitFor(() => expect(saveDbSetting).toHaveBeenCalledTimes(1));
    expect(saveDbSetting).toHaveBeenCalledTimes(1);
    expect(saveDbSetting).toHaveBeenNthCalledWith(1, STUDIO_LAYOUT_DB_KEY, expect.objectContaining({ leftWidth: 300 }));
    releaseFirst();
    await Promise.all([first, second]);

    expect(saveDbSetting).toHaveBeenCalledTimes(2);
    expect(saveDbSetting).toHaveBeenNthCalledWith(2, STUDIO_LAYOUT_DB_KEY, expect.objectContaining({
      leftWidth: 390,
      focusMode: true,
    }));
  });
});
