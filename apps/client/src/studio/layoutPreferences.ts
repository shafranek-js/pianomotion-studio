import { getDbSetting, saveDbSetting } from "../storage/index.ts";
import type { InspectorTab, StudioLayoutPreferences } from "./types.ts";

export const STUDIO_LAYOUT_DB_KEY = "studio.layout.v1";

export const DEFAULT_STUDIO_LAYOUT_PREFERENCES: StudioLayoutPreferences = {
  activePanel: null,
  pinnedSide: null,
  leftWidth: 320,
  rightWidth: 360,
  splitRatio: 0.5,
  inspectorTab: "scene",
  focusMode: false,
};

const inspectorTabs: readonly InspectorTab[] = ["scene", "pianist", "audio", "diagnostics"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function sanitizeStudioLayoutPreferences(value: unknown): StudioLayoutPreferences {
  if (!isRecord(value)) return { ...DEFAULT_STUDIO_LAYOUT_PREFERENCES };
  const activePanel = value.activePanel === "projects" || value.activePanel === "inspector"
    ? value.activePanel
    : null;
  // A persisted dock belongs to the active panel. Projects stay on the left and
  // Inspector stays on the right, even when loading an older mismatched record.
  const hasPinnedPanel = value.pinnedSide === "left" || value.pinnedSide === "right";
  const pinnedSide = !hasPinnedPanel ? null
    : activePanel === "projects" ? "left"
      : activePanel === "inspector" ? "right"
        : value.pinnedSide as "left" | "right";
  const inspectorTab = inspectorTabs.includes(value.inspectorTab as InspectorTab)
    ? value.inspectorTab as InspectorTab
    : DEFAULT_STUDIO_LAYOUT_PREFERENCES.inspectorTab;
  const splitValue = typeof value.splitRatio === "number" && Number.isFinite(value.splitRatio)
    ? Math.min(0.75, Math.max(0.25, value.splitRatio))
    : DEFAULT_STUDIO_LAYOUT_PREFERENCES.splitRatio;

  return {
    activePanel,
    pinnedSide,
    leftWidth: boundedNumber(value.leftWidth, DEFAULT_STUDIO_LAYOUT_PREFERENCES.leftWidth, 280, 400),
    rightWidth: boundedNumber(value.rightWidth, DEFAULT_STUDIO_LAYOUT_PREFERENCES.rightWidth, 300, 440),
    splitRatio: Math.round(splitValue * 100) / 100,
    inspectorTab,
    focusMode: value.focusMode === true,
  };
}

export async function loadStudioLayoutPreferences(): Promise<StudioLayoutPreferences> {
  const stored = await getDbSetting<unknown>(STUDIO_LAYOUT_DB_KEY);
  return sanitizeStudioLayoutPreferences(stored);
}

let pendingWrite: Promise<void> = Promise.resolve();

/** Queue writes so rapid layout changes cannot finish out of order in IndexedDB. */
export function saveStudioLayoutPreferences(value: unknown): Promise<void> {
  const preferences = sanitizeStudioLayoutPreferences(value);
  const write = pendingWrite.catch(() => undefined).then(() =>
    saveDbSetting(STUDIO_LAYOUT_DB_KEY, preferences),
  );
  pendingWrite = write;
  return write;
}
