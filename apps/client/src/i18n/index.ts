export type {
  AppLanguage,
  CommonTranslations,
  WelcomeTranslations,
  HeaderTranslations,
  ViewsTranslations,
  PlaybackTranslations,
  EditorTranslations,
  SettingsTranslations,
  PianistTranslations,
  ExportTranslations,
  MelodiesTranslations,
  ProjectsTranslations,
  DiagnosticsTranslations,
  DialogsTranslations,
  StageAppearanceTranslations,
  RailTranslations,
  PracticeTranslations,
  TranslationDictionary,
  TranslationKey,
  TranslationParams,
  TranslateFunction,
  I18nContextValue,
} from "./types.ts";

export {
  I18nContext,
  I18nProvider,
  useI18n,
  SUPPORTED_LANGUAGES,
  type I18nProviderProps,
} from "./I18nContext.tsx";

export {
  getTranslation,
  interpolate,
  dictionaries,
} from "./getTranslation.ts";

export { en } from "./locales/en.ts";
export { cs } from "./locales/cs.ts";
export { uk } from "./locales/uk.ts";
export { de } from "./locales/de.ts";
export { es } from "./locales/es.ts";
export { it } from "./locales/it.ts";
