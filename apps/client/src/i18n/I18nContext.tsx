/* eslint-disable react-refresh/only-export-components */
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import type {
  AppLanguage,
  I18nContextValue,
  TranslationDictionary,
  TranslationParams,
} from "./types.ts";
import { dictionaries, getTranslation } from "./getTranslation.ts";
import {
  getSettings,
  updateSettings,
  updateSettingsPersisted,
  subscribeSettings,
} from "../settings/settingsStore.ts";

export const SUPPORTED_LANGUAGES: { id: AppLanguage; label: string }[] = [
  { id: "en", label: "English" },
  { id: "cs", label: "Čeština" },
  { id: "uk", label: "Українська" },
  { id: "de", label: "Deutsch" },
  { id: "es", label: "Español" },
  { id: "it", label: "Italiano" },
];

export const I18nContext = createContext<I18nContextValue>({
  language: "en",
  setLanguage: () => {},
  t: (path: string, params?: TranslationParams) => getTranslation("en", path, params),
  dict: dictionaries.en,
});

export interface I18nProviderProps {
  language?: AppLanguage;
  children?: ReactNode;
}

export function I18nProvider({ language: controlledLanguage, children }: I18nProviderProps) {
  const [internalLanguage, setInternalLanguage] = useState<AppLanguage>(() => {
    return controlledLanguage ?? getSettings().language ?? "en";
  });

  useEffect(() => {
    if (controlledLanguage) return;
    const unsubscribe = subscribeSettings((nextSettings) => {
      if (SUPPORTED_LANGUAGES.some((item) => item.id === nextSettings.language)) {
        setInternalLanguage(nextSettings.language);
      }
    });
    return unsubscribe;
  }, [controlledLanguage]);

  const activeLanguage: AppLanguage = controlledLanguage ?? internalLanguage;

  const setLanguage = useCallback(
    (newLang: AppLanguage) => {
      setInternalLanguage(newLang);
      if (!controlledLanguage) {
        updateSettings({ language: newLang });
        void updateSettingsPersisted({ language: newLang }).catch(() => {});
      }
    },
    [controlledLanguage],
  );

  const t = useCallback(
    (path: string, params?: TranslationParams) => {
      return getTranslation(activeLanguage, path, params);
    },
    [activeLanguage],
  );

  const dict = useMemo<TranslationDictionary>(() => {
    return dictionaries[activeLanguage] ?? dictionaries.en;
  }, [activeLanguage]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language: activeLanguage,
      setLanguage,
      t,
      dict,
    }),
    [activeLanguage, setLanguage, t, dict],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
