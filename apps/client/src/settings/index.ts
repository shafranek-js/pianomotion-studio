export {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SettingsSchema,
  KeyStyleSchema,
  SoundTimbreSchema,
  RenderCapFpsSchema,
  SkinStyleSchema,
  sanitizeSettings,
  type Settings,
  type AppSettings,
  type KeyStyle,
  type SoundTimbre,
  type RenderCapFps,
  type SkinStyleSetting,
  type SettingsListener,
} from "./types.ts";

export {
  SETTINGS_DB_KEY,
  SettingsStore,
  settingsStore,
  initializeSettings,
  getSettings,
  updateSettings,
  updateSettingsPersisted,
  resetToDefaults,
  resetToDefaultsPersisted,
  subscribeSettings,
  setSettingsStorage,
} from "./settingsStore.ts";

export { SettingsModal, type SettingsModalProps } from "./SettingsModal.tsx";
