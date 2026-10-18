import { en } from "./locales/en.ts";
import { cs } from "./locales/cs.ts";
import { uk } from "./locales/uk.ts";
import { de } from "./locales/de.ts";
import { es } from "./locales/es.ts";
import { it } from "./locales/it.ts";
import type { AppLanguage, TranslationDictionary, TranslationParams } from "./types.ts";

export const dictionaries: Record<AppLanguage, TranslationDictionary> = {
  en,
  cs,
  uk,
  de,
  es,
  it,
};

export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{([^{}]+)\}/g, (match, key) => {
    const trimmed = key.trim();
    return trimmed in params ? String(params[trimmed]) : match;
  });
}

function resolvePath(dict: unknown, path: string): string | undefined {
  if (!dict || typeof dict !== "object" || !path) return undefined;
  const segments = path.split(".");
  let cur: unknown = dict;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object" || !(seg in (cur as Record<string, unknown>))) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Retrieves a translated string for the specified language and path.
 * If the path is not found in the target language, falls back to English.
 * If not found in English either, returns the path itself.
 * Interpolates variables formatted as `{variableName}` using the provided params.
 */
export function getTranslation(
  lang: AppLanguage,
  path: string,
  params?: TranslationParams,
): string {
  const dict = dictionaries[lang] ?? dictionaries.en;
  let text = resolvePath(dict, path);
  if (text === undefined && lang !== "en") {
    text = resolvePath(dictionaries.en, path);
  }
  if (text === undefined) {
    return interpolate(path, params);
  }
  return interpolate(text, params);
}
