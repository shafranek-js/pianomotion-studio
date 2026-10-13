import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  sanitizeSettings,
  type Settings,
  type SettingsListener,
} from "./types.ts";
import { getDbSetting, saveDbSetting } from "../storage/projectDb.ts";

export const SETTINGS_DB_KEY = "app.settings";

let customStorage: Storage | null = null;

/**
 * Injects a custom Storage implementation (e.g. for testing or Node-based environments).
 */
export function setSettingsStorage(storage: Storage | null): void {
  customStorage = storage;
  settingsStore.reload();
}

function resolveStorage(): Storage | null {
  if (customStorage) {
    return customStorage;
  }
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return null;
}

/**
 * Reactive store for application settings backed by localStorage persistence (`handthesia:settings`).
 */
export class SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<SettingsListener>();
  private readonly storageKey: string;
  private initialized = false;
  private initializationPromise: Promise<Settings> | null = null;
  private writeQueue: Promise<Settings> = Promise.resolve({ ...DEFAULT_SETTINGS });

  constructor(storageKey = SETTINGS_STORAGE_KEY) {
    this.storageKey = storageKey;
    this.current = this.loadFromStorage();
  }

  /** Loads IndexedDB first and migrates the legacy localStorage value without deleting it. */
  initialize(): Promise<Settings> {
    if (this.initialized) return Promise.resolve(this.getSettings());
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = (async () => {
      const stored = await getDbSetting<unknown>(SETTINGS_DB_KEY);
      if (stored !== null) {
        this.current = sanitizeSettings(stored);
      } else {
        const legacy = this.readLegacyValue();
        if (legacy.exists) {
          this.current = legacy.settings;
          await saveDbSetting(SETTINGS_DB_KEY, this.current);
        } else {
          this.current = { ...DEFAULT_SETTINGS };
        }
      }
      this.initialized = true;
      this.notify();
      return this.getSettings();
    })().finally(() => {
      this.initializationPromise = null;
    });
    return this.initializationPromise;
  }

  /**
   * Reloads settings from the underlying storage.
   */
  reload(): Settings {
    this.current = this.loadFromStorage();
    this.initialized = false;
    return this.getSettings();
  }

  private readLegacyValue(): { exists: boolean; settings: Settings } {
    const storage = resolveStorage();
    if (!storage) return { exists: false, settings: { ...DEFAULT_SETTINGS } };
    try {
      const raw = storage.getItem(this.storageKey);
      return raw === null
        ? { exists: false, settings: { ...DEFAULT_SETTINGS } }
        : { exists: true, settings: sanitizeSettings(JSON.parse(raw)) };
    } catch {
      return { exists: false, settings: { ...DEFAULT_SETTINGS } };
    }
  }

  private loadFromStorage(): Settings {
    const storage = resolveStorage();
    if (!storage) {
      return { ...DEFAULT_SETTINGS };
    }

    try {
      const raw = storage.getItem(this.storageKey);
      if (!raw) {
        return { ...DEFAULT_SETTINGS };
      }
      const parsed = JSON.parse(raw);
      return sanitizeSettings(parsed);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private persist(settings: Settings): void {
    const storage = resolveStorage();
    if (!storage) {
      return;
    }

    try {
      storage.setItem(this.storageKey, JSON.stringify(settings));
    } catch (err) {
      console.warn("SettingsStore: Failed to persist settings to storage:", err);
    }
  }

  private notify(): void {
    const snapshot = this.getSettings();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("SettingsStore: Error inside subscriber listener:", err);
      }
    }
  }

  /**
   * Retrieves the current settings snapshot.
   */
  getSettings(): Settings {
    return { ...this.current };
  }

  /**
   * Updates settings with the provided partial values, persists to storage,
   * and notifies all active subscribers.
   */
  updateSettings(partial: Partial<Settings>): Settings {
    const merged = { ...this.current, ...partial };
    this.current = sanitizeSettings(merged);
    this.persist(this.current);
    this.notify();
    return this.getSettings();
  }

  /** Writes settings to IndexedDB before publishing them to listeners. */
  updateSettingsPersisted(partial: Partial<Settings>): Promise<Settings> {
    const operation = this.writeQueue.catch(() => this.getSettings()).then(async () => {
      await this.initialize();
      const next = sanitizeSettings({ ...this.current, ...partial });
      await saveDbSetting(SETTINGS_DB_KEY, next);
      this.current = next;
      this.initialized = true;
      this.notify();
      return this.getSettings();
    });
    this.writeQueue = operation;
    return operation;
  }

  /**
   * Resets settings back to DEFAULT_SETTINGS, persists to storage,
   * and notifies all active subscribers.
   */
  resetToDefaults(): Settings {
    this.current = { ...DEFAULT_SETTINGS };
    this.persist(this.current);
    this.notify();
    return this.getSettings();
  }

  /** Writes defaults to IndexedDB before notifying listeners. */
  resetToDefaultsPersisted(): Promise<Settings> {
    const operation = this.writeQueue.catch(() => this.getSettings()).then(async () => {
      await this.initialize();
      const defaults = { ...DEFAULT_SETTINGS };
      await saveDbSetting(SETTINGS_DB_KEY, defaults);
      this.current = defaults;
      this.initialized = true;
      this.notify();
      return this.getSettings();
    });
    this.writeQueue = operation;
    return operation;
  }

  /**
   * Subscribes a listener to receive future settings changes.
   * Returns an unsubscribe function.
   */
  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * Singleton SettingsStore instance.
 */
export const settingsStore = new SettingsStore();

export function getSettings(): Settings {
  return settingsStore.getSettings();
}

export function updateSettings(partial: Partial<Settings>): Settings {
  return settingsStore.updateSettings(partial);
}

export function updateSettingsPersisted(partial: Partial<Settings>): Promise<Settings> {
  return settingsStore.updateSettingsPersisted(partial);
}

export function resetToDefaults(): Settings {
  return settingsStore.resetToDefaults();
}

export function resetToDefaultsPersisted(): Promise<Settings> {
  return settingsStore.resetToDefaultsPersisted();
}

export function initializeSettings(): Promise<Settings> {
  return settingsStore.initialize();
}

export function subscribeSettings(listener: SettingsListener): () => void {
  return settingsStore.subscribe(listener);
}
