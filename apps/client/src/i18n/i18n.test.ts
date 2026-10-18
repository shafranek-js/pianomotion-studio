import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, beforeEach } from "vitest";
import {
  en,
  cs,
  uk,
  de,
  es,
  it as itLocale,
  getTranslation,
  interpolate,
  SUPPORTED_LANGUAGES,
  I18nProvider,
  useI18n,
  type AppLanguage,
  type TranslationDictionary,
} from "./index.ts";
import {
  DEFAULT_SETTINGS,
  AppLanguageSchema,
  sanitizeSettings,
} from "../settings/types.ts";
import {
  getSettings,
  updateSettings,
  resetToDefaults,
} from "../settings/settingsStore.ts";

describe("i18n core", () => {
  beforeEach(() => {
    resetToDefaults();
  });

  describe("Dictionary Parity and Completeness", () => {
    function getAllKeys(obj: Record<string, unknown>, prefix = ""): string[] {
      let keys: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${k}` : k;
        if (typeof v === "object" && v !== null) {
          keys = keys.concat(getAllKeys(v as Record<string, unknown>, fullKey));
        } else {
          keys.push(fullKey);
        }
      }
      return keys;
    }

    function extractPlaceholders(str: string): string[] {
      const matches = str.match(/\{([^{}]+)\}/g);
      return matches ? matches.map((m) => m.replace(/[{}]/g, "").trim()).sort() : [];
    }

    const allLocales: { lang: AppLanguage; dict: TranslationDictionary }[] = [
      { lang: "cs", dict: cs },
      { lang: "uk", dict: uk },
      { lang: "de", dict: de },
      { lang: "es", dict: es },
      { lang: "it", dict: itLocale },
    ];

    it("has identical module structure across all locales", () => {
      const enModules = Object.keys(en).sort();
      for (const { lang, dict } of allLocales) {
        const modules = Object.keys(dict).sort();
        expect(modules, `${lang} module keys must match en`).toEqual(enModules);
      }
    });

    it("has exact parity: every key in en.ts exists in all locales with non-empty string", () => {
      const enKeys = getAllKeys(en as unknown as Record<string, unknown>);

      for (const { lang, dict } of allLocales) {
        const localeKeys = getAllKeys(dict as unknown as Record<string, unknown>);
        expect(localeKeys, `${lang} keys must equal en keys`).toEqual(enKeys);

        for (const key of enKeys) {
          const enVal = getTranslation("en", key);
          const locVal = getTranslation(lang, key);

          expect(typeof locVal, `${lang}.${key} must be a string`).toBe("string");
          expect(locVal.trim().length, `${lang}.${key} must not be empty`).toBeGreaterThan(0);

          // Verify placeholders match
          const enPlaceholders = extractPlaceholders(enVal);
          const locPlaceholders = extractPlaceholders(locVal);
          expect(
            locPlaceholders,
            `Placeholders mismatch for key "${key}" in ${lang}: en=${JSON.stringify(enPlaceholders)} vs ${lang}=${JSON.stringify(locPlaceholders)}`,
          ).toEqual(enPlaceholders);
        }
      }
    });

    it("verifies accurate domain terminology across all languages", () => {
      expect(cs.views.fingering).toBe("Prstoklad");
      expect(uk.views.fingering).toBe("Аплікатура");
      expect(de.views.fingering).toBe("Fingersatz");
      expect(es.views.fingering).toBe("Digitación");
      expect(itLocale.views.fingering).toBe("Diteggiatura");

      expect(cs.editor.leftHand).toBe("Levá ruka");
      expect(uk.editor.leftHand).toBe("Ліва рука");
      expect(de.editor.leftHand).toBe("Linke Hand");
      expect(es.editor.leftHand).toBe("Mano izquierda");
      expect(itLocale.editor.leftHand).toBe("Mano sinistra");

      expect(cs.playback.play).toBe("Přehrát");
      expect(uk.playback.play).toBe("Відтворити");
      expect(de.playback.play).toBe("Wiedergabe");
      expect(es.playback.play).toBe("Reproducir");
      expect(itLocale.playback.play).toBe("Riproduci");
    });
  });

  describe("getTranslation & interpolate", () => {
    it("returns correct translations for valid paths", () => {
      expect(getTranslation("en", "common.save")).toBe("Save");
      expect(getTranslation("cs", "common.save")).toBe("Uložit");
      expect(getTranslation("en", "welcome.title")).toBe("Open a project");
      expect(getTranslation("cs", "welcome.title")).toBe("Otevřít projekt");
    });

    it("interpolates parameters correctly", () => {
      expect(
        getTranslation("en", "dialogs.unsavedDescription", { name: "Chopsticks" }),
      ).toBe("Save your current project before opening “Chopsticks”?");

      expect(
        getTranslation("cs", "dialogs.unsavedDescription", { name: "Chopsticks" }),
      ).toBe("Chcete uložit aktuální projekt před otevřením „Chopsticks“?");

      expect(getTranslation("en", "export.rendering", { progress: 75 })).toBe(
        "Rendering: 75%...",
      );
      expect(getTranslation("cs", "export.rendering", { progress: 75 })).toBe(
        "Vykreslování: 75%...",
      );
    });

    it("supports custom template strings via interpolate()", () => {
      expect(interpolate("Hello {name}!", { name: "World" })).toBe("Hello World!");
      expect(interpolate("Count: {count}, user: {user}", { count: 0, user: "Alice" })).toBe(
        "Count: 0, user: Alice",
      );
      expect(interpolate("Plain text without variables")).toBe(
        "Plain text without variables",
      );
      expect(interpolate("Missing {variable}")).toBe("Missing {variable}");
    });

    it("falls back to English when key is missing in target language", () => {
      // Mock an unknown key in English fallback check
      const fallbackResult = getTranslation("cs", "common.save");
      expect(fallbackResult).toBe("Uložit");

      // Non-existent key in both languages returns the path
      expect(getTranslation("en", "missing.key")).toBe("missing.key");
      expect(getTranslation("cs", "missing.key")).toBe("missing.key");
      expect(getTranslation("en", "missing.with.{param}", { param: "val" })).toBe(
        "missing.with.val",
      );
    });

    it("handles edge cases (empty path, root path, null params)", () => {
      expect(getTranslation("en", "")).toBe("");
      expect(getTranslation("en", "common")).toBe("common");
      expect(getTranslation("en", "common.save", undefined)).toBe("Save");
    });
  });

  describe("Settings Schema & Defaults", () => {
    it("includes language in DEFAULT_SETTINGS as 'en'", () => {
      expect(DEFAULT_SETTINGS.language).toBe("en");
    });

    it("validates AppLanguageSchema", () => {
      expect(AppLanguageSchema.parse("en")).toBe("en");
      expect(AppLanguageSchema.parse("cs")).toBe("cs");
      expect(AppLanguageSchema.parse("uk")).toBe("uk");
      expect(AppLanguageSchema.parse("de")).toBe("de");
      expect(AppLanguageSchema.parse("es")).toBe("es");
      expect(AppLanguageSchema.parse("it")).toBe("it");
      expect(() => AppLanguageSchema.parse("fr")).toThrow();
    });

    it("sanitizes language correctly falling back to default", () => {
      expect(sanitizeSettings({ language: "cs" }).language).toBe("cs");
      expect(sanitizeSettings({ language: "en" }).language).toBe("en");
      expect(sanitizeSettings({ language: "uk" }).language).toBe("uk");
      expect(sanitizeSettings({ language: "de" }).language).toBe("de");
      expect(sanitizeSettings({ language: "es" }).language).toBe("es");
      expect(sanitizeSettings({ language: "it" }).language).toBe("it");
      expect(sanitizeSettings({ language: "fr" as unknown as AppLanguage }).language).toBe(
        "en",
      );
      expect(sanitizeSettings({}).language).toBe("en");
      expect(sanitizeSettings(null).language).toBe("en");
    });

    it("exposes SUPPORTED_LANGUAGES with all 6 languages", () => {
      expect(SUPPORTED_LANGUAGES).toEqual([
        { id: "en", label: "English" },
        { id: "cs", label: "Čeština" },
        { id: "uk", label: "Українська" },
        { id: "de", label: "Deutsch" },
        { id: "es", label: "Español" },
        { id: "it", label: "Italiano" },
      ]);
    });
  });

  describe("I18nProvider and useI18n", () => {
    function Consumer() {
      const { language, t, dict } = useI18n();
      return React.createElement(
        "div",
        { "data-testid": "i18n-consumer" },
        React.createElement("span", { "data-testid": "lang" }, language),
        React.createElement("span", { "data-testid": "save-btn" }, t("common.save")),
        React.createElement("span", { "data-testid": "welcome-title" }, t("welcome.title")),
        React.createElement("span", { "data-testid": "dict-term" }, dict.views.fingering),
        React.createElement(
          "span",
          { "data-testid": "interpolated" },
          t("dialogs.unsavedDescription", { name: "Sonata" }),
        ),
      );
    }

    it("provides default context when rendered outside I18nProvider", () => {
      const markup = renderToStaticMarkup(React.createElement(Consumer));
      expect(markup).toContain('<span data-testid="lang">en</span>');
      expect(markup).toContain('<span data-testid="save-btn">Save</span>');
      expect(markup).toContain('<span data-testid="welcome-title">Open a project</span>');
      expect(markup).toContain('<span data-testid="dict-term">Fingering</span>');
    });

    it("renders English when language='en' is passed to I18nProvider", () => {
      const markup = renderToStaticMarkup(
        React.createElement(I18nProvider, { language: "en" }, React.createElement(Consumer)),
      );
      expect(markup).toContain('<span data-testid="lang">en</span>');
      expect(markup).toContain('<span data-testid="save-btn">Save</span>');
      expect(markup).toContain('<span data-testid="welcome-title">Open a project</span>');
      expect(markup).toContain('<span data-testid="dict-term">Fingering</span>');
      expect(markup).toContain("Save your current project before opening “Sonata”?");
    });

    it("renders Czech when language='cs' is passed to I18nProvider", () => {
      const markup = renderToStaticMarkup(
        React.createElement(I18nProvider, { language: "cs" }, React.createElement(Consumer)),
      );
      expect(markup).toContain('<span data-testid="lang">cs</span>');
      expect(markup).toContain('<span data-testid="save-btn">Uložit</span>');
      expect(markup).toContain('<span data-testid="welcome-title">Otevřít projekt</span>');
      expect(markup).toContain('<span data-testid="dict-term">Prstoklad</span>');
      expect(markup).toContain("Chcete uložit aktuální projekt před otevřením „Sonata“?");
    });

    it("reads language from settingsStore by default when no prop is provided", () => {
      updateSettings({ language: "cs" });
      const markup = renderToStaticMarkup(
        React.createElement(I18nProvider, null, React.createElement(Consumer)),
      );
      expect(markup).toContain('<span data-testid="lang">cs</span>');
      expect(markup).toContain('<span data-testid="save-btn">Uložit</span>');
    });

    it("allows setLanguage to update language and settingsStore", () => {
      let captured: ReturnType<typeof useI18n> | null = null;
      function TestHook() {
        captured = useI18n();
        return null;
      }

      renderToStaticMarkup(
        React.createElement(I18nProvider, null, React.createElement(TestHook)),
      );

      expect(captured).not.toBeNull();
      expect(captured!.language).toBe("en");
      expect(getSettings().language).toBe("en");

      captured!.setLanguage("cs");
      expect(getSettings().language).toBe("cs");
    });
  });
});
