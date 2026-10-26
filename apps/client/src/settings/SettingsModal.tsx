import React, { useState, useEffect, useRef, useCallback } from "react";
import { Check, Settings2, Trash2, Upload, X } from "lucide-react";
import {
  getSettings,
  updateSettingsPersisted,
  resetToDefaultsPersisted,
  subscribeSettings,
} from "./settingsStore";
import type { AppSettings, CalculationEngine, HandModel, SkinStyleSetting } from "./types";
import { getStorageQuota, clearSessionSnapshot } from "../storage";
import {
  listSoundFontAssets,
  saveSoundFontAsset,
  deleteSoundFontAsset,
  type SoundFontAssetMetadata,
  MAX_SF2_FILE_BYTES,
  type Sf2Progress,
} from "../audio/soundfont/index.ts";
import { BUILTIN_SOUNDFONT_ID, BUILTIN_SOUNDFONT_NAME } from "../audio/soundfont/builtinSoundfont.ts";
import { releaseAssetUrl } from "../pwa/urls";
import { WebMidiOutputManager, getSharedWebMidiOutputManager } from "../midi/webMidiOutput.ts";
import type { WebMidiStatus } from "../midi/types.ts";
import { useI18n, SUPPORTED_LANGUAGES, type AppLanguage } from "../i18n";

export interface SettingsModalProps {
  presentation?: "dialog" | "workspace";
  isOpen: boolean;
  onClose: () => void;
  onSettingsChanged?: (settings: AppSettings) => void;
}

export function SettingsModal({ isOpen, onClose, onSettingsChanged, presentation = "dialog" }: SettingsModalProps) {
  const { dict, setLanguage } = useI18n();
  const [settings, setSettings] = useState<AppSettings>(getSettings());
  const [quotaInfo, setQuotaInfo] = useState<{ usageBytes: number; quotaBytes: number; percentUsed: number } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [soundfonts, setSoundfonts] = useState<SoundFontAssetMetadata[]>([]);
  const [sfUploading, setSfUploading] = useState(false);
  const [sfError, setSfError] = useState<string | null>(null);
  const [sfProgress, setSfProgress] = useState<Sf2Progress | null>(null);
  const sfAbortController = useRef<AbortController | null>(null);
  const [midiStatus, setMidiStatus] = useState<WebMidiStatus | null>(null);
  const midiManagerRef = useRef<WebMidiOutputManager | null>(null);
  const pendingValues = useRef<Partial<AppSettings>>({});
  const changeVersions = useRef<Partial<Record<keyof AppSettings, number>>>({});

  const handleChange = useCallback(async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setStorageError(null);
    const version = (changeVersions.current[key] ?? 0) + 1;
    changeVersions.current[key] = version;
    pendingValues.current[key] = value;
    // Reflect an input gesture immediately. The committed store stays unchanged
    // until IndexedDB completes; a failed write rolls this field back.
    setSettings((current) => ({ ...current, [key]: value }));
    try {
      const updated = await updateSettingsPersisted({ [key]: value });
      if (changeVersions.current[key] === version) delete pendingValues.current[key];
      setSettings({ ...updated, ...pendingValues.current });
    } catch (error) {
      if (changeVersions.current[key] === version) delete pendingValues.current[key];
      setSettings({ ...getSettings(), ...pendingValues.current });
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeSettings((updated) => {
      setSettings({ ...updated, ...pendingValues.current });
      onSettingsChanged?.(updated);
    });
    return unsubscribe;
  }, [onSettingsChanged]);

  useEffect(() => {
    if (isOpen) {
      void getStorageQuota().then((q) => setQuotaInfo(q));
      void listSoundFontAssets().then((list) => {
        setSoundfonts(list);
      });
    }
  }, [isOpen, settings.soundfontAssetId, handleChange]);

  useEffect(() => {
    if (!isOpen) sfAbortController.current?.abort();
  }, [isOpen]);

  useEffect(() => () => sfAbortController.current?.abort(), []);

  useEffect(() => {
    if (isOpen && settings.soundOutput === "webmidi") {
      if (!midiManagerRef.current) {
        midiManagerRef.current = getSharedWebMidiOutputManager();
      }
      const manager = midiManagerRef.current;
      const unsubscribe = manager.subscribe((status) => {
        setMidiStatus(status);
        if (status.devices.length > 0 && !settings.webMidiDeviceId) {
          const firstDevice = status.devices[0]!;
          manager.selectDevice(firstDevice.id);
          void handleChange("webMidiDeviceId", firstDevice.id);
        }
      });
      void manager.init().then(() => {
        if (settings.webMidiDeviceId) {
          manager.selectDevice(settings.webMidiDeviceId);
        }
      });
      return () => {
        unsubscribe();
      };
    } else if (midiManagerRef.current) {
      midiManagerRef.current = null;
    }
  }, [isOpen, settings.soundOutput, settings.webMidiDeviceId, handleChange]);

  const handleSoundFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_SF2_FILE_BYTES) {
      setSfError("SoundFont exceeds the 1 GiB limit.");
      e.target.value = "";
      return;
    }
    sfAbortController.current?.abort();
    const controller = new AbortController();
    sfAbortController.current = controller;
    setSfUploading(true);
    setSfError(null);
    setSfProgress({ phase: "reading", loadedBytes: 0, totalBytes: file.size });
    try {
      const meta = await saveSoundFontAsset(file.name, file, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (sfAbortController.current === controller) setSfProgress(progress);
        },
      });
      const list = await listSoundFontAssets();
      if (controller.signal.aborted || sfAbortController.current !== controller) return;
      setSoundfonts(list);
      await handleChange("soundfontAssetId", meta.id);
      if (controller.signal.aborted || sfAbortController.current !== controller) return;
      setFeedback(`SoundFont "${meta.name}" loaded successfully.`);
      setTimeout(() => setFeedback(null), 3000);
    } catch (err: unknown) {
      if (sfAbortController.current !== controller) return;
      if (err instanceof Error && err.name === "AbortError") {
        setFeedback("SoundFont import cancelled.");
        setTimeout(() => setFeedback(null), 2500);
      } else {
        setSfError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (sfAbortController.current === controller) {
        sfAbortController.current = null;
        setSfUploading(false);
        setSfProgress(null);
        e.target.value = "";
      }
    }
  };

  const handleSoundFontDelete = async (id: string) => {
    try {
      await deleteSoundFontAsset(id);
      const list = await listSoundFontAssets();
      setSoundfonts(list);
      if (settings.soundfontAssetId === id) {
        await handleChange("soundfontAssetId", BUILTIN_SOUNDFONT_ID);
      }
      setFeedback("SoundFont removed.");
      setTimeout(() => setFeedback(null), 2500);
    } catch (err: unknown) {
      setSfError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!isOpen) return null;

  const handleReset = async () => {
    setStorageError(null);
    try {
      const defs = await resetToDefaultsPersisted();
      setSettings({...defs, ...pendingValues.current});
      setFeedback("Settings reset to defaults.");
      setTimeout(() => setFeedback(null), 2500);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleClearCache = async () => {
    setStorageError(null);
    try {
      await clearSessionSnapshot();
      const q = await getStorageQuota();
      setQuotaInfo(q);
      setFeedback("Session autosave cache cleared.");
      setTimeout(() => setFeedback(null), 2500);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  };

  return (
    <div
      className="modal-backdrop"
      role={presentation === "dialog" ? "dialog" : undefined}
      aria-modal={presentation === "dialog" ? true : undefined}
      aria-labelledby={presentation === "dialog" ? "settings-modal-title" : undefined}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
    >
      <div
        className="modal-content"
        style={{
          background: "var(--panel, #19211d)",
          border: "1px solid var(--border, #33423a)",
          borderRadius: "0.85rem",
          width: "100%",
          maxWidth: "640px",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          color: "#edf2ed",
          boxShadow: "0 20px 40px rgba(0, 0, 0, 0.6)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "1rem 1.25rem",
            borderBottom: "1px solid var(--border, #33423a)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <Settings2 size={20} aria-hidden="true" />
            <h2 id="settings-modal-title" style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>
              {dict.settings.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={dict.common.close}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--muted, #9fac9f)",
              fontSize: "1.2rem",
              cursor: "pointer",
              padding: "0.2rem 0.5rem",
            }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: "1.25rem", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {feedback && (
            <div
              role="status"
              style={{
                padding: "0.5rem 0.8rem",
                borderRadius: "0.4rem",
                background: "rgba(16, 185, 129, 0.15)",
                border: "1px solid rgba(16, 185, 129, 0.4)",
                color: "#34d399",
                fontSize: "0.82rem",
              }}
            >
              <Check size={14} aria-hidden="true" /> {feedback}
            </div>
          )}
          {storageError && (
            <div role="alert" style={{ color: "#f87171", fontSize: "0.82rem" }}>
              Change was not saved: {storageError}
            </div>
          )}

          {/* Section 1: General / Visual & Keyboard Geometry */}
          <div
            style={{
              background: "var(--panel-raised, #202b25)",
              padding: "1rem",
              borderRadius: "0.6rem",
              border: "1px solid var(--border, #33423a)",
            }}
          >
            <h3 style={{ margin: "0 0 0.8rem 0", fontSize: "0.9rem", color: "var(--mint, #a9d3bb)" }}>
              {dict.settings.general} / {dict.settings.visual}
            </h3>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div>
                <label htmlFor="settings-language" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  {dict.settings.language}:
                </label>
                <select
                  id="settings-language"
                  value={settings.language}
                  onChange={(e) => {
                    const val = e.target.value as AppLanguage;
                    void handleChange("language", val);
                    setLanguage(val);
                  }}
                  style={{
                    background: "#19211d",
                    color: "#edf2ed",
                    border: "1px solid var(--border, #33423a)",
                    borderRadius: "0.35rem",
                    padding: "0.4rem 0.6rem",
                    fontSize: "0.85rem",
                  }}
                >
                  {SUPPORTED_LANGUAGES.map((lang) => {
                    const langNames: Record<AppLanguage, string> = {
                      en: dict.settings.languageEn,
                      cs: dict.settings.languageCs,
                      uk: dict.settings.languageUk,
                      de: dict.settings.languageDe,
                      es: dict.settings.languageEs,
                      it: dict.settings.languageIt,
                    };
                    return (
                      <option key={lang.id} value={lang.id}>
                        {langNames[lang.id] ?? lang.label}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label htmlFor="settings-key-style" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  {dict.settings.keyStyle}:
                </label>
                <select
                  id="settings-key-style"
                  value={settings.keyStyle}
                  onChange={(e) => handleChange("keyStyle", e.target.value as "realistic" | "equal")}
                  style={{
                    background: "#19211d",
                    color: "#edf2ed",
                    border: "1px solid var(--border, #33423a)",
                    borderRadius: "0.35rem",
                    padding: "0.4rem 0.6rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <option value="realistic">{dict.settings.realisticKeys}</option>
                  <option value="equal">{dict.settings.equalKeys}</option>
                </select>
                <div style={{ marginTop: "0.25rem", fontSize: "0.75rem", color: "var(--muted, #9fac9f)", lineHeight: 1.4 }}>
                  Realistic geometry is required for accurate 3D finger placement on the piano keys.
                </div>
              </div>

              <div>
                <label htmlFor="settings-skin-style" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  {dict.settings.skinStyle}:
                </label>
                <select
                  id="settings-skin-style"
                  value={settings.skinStyle}
                  onChange={(e) => handleChange("skinStyle", e.target.value as SkinStyleSetting)}
                  style={{
                    background: "#19211d",
                    color: "#edf2ed",
                    border: "1px solid var(--border, #33423a)",
                    borderRadius: "0.35rem",
                    padding: "0.4rem 0.6rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <option value="realistic">{dict.settings.skinRealistic}</option>
                  <option value="cartoon">{dict.settings.skinCartoon}</option>
                  <option value="gloves">{dict.settings.skinGloves}</option>
                  <option value="robot">{dict.settings.skinRobot}</option>
                  <option value="skeleton">{dict.settings.skinSkeleton}</option>
                </select>
              </div>

              <div>
                <label htmlFor="settings-hand-model" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  {dict.settings.handModel}:
                </label>
                <select
                  id="settings-hand-model"
                  value={settings.handModel}
                  onChange={(e) => handleChange("handModel", e.target.value as HandModel)}
                  style={{
                    background: "#19211d",
                    color: "#edf2ed",
                    border: "1px solid var(--border, #33423a)",
                    borderRadius: "0.35rem",
                    padding: "0.4rem 0.6rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <option value="anatomical">{dict.settings.handModelAnatomical}</option>
                  <option value="anatomical-improved">{dict.settings.handModelAnatomicalImproved}</option>
                    <option value="testing">{dict.settings.handModelTesting}</option>
                  <option value="webxr">{dict.settings.handModelWebxr}</option>
                </select>
              </div>

              <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginTop: "0.2rem" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={settings.showFingerLabels}
                    onChange={(e) => handleChange("showFingerLabels", e.target.checked)}
                    style={{ accentColor: "var(--mint, #a9d3bb)" }}
                  />
                  {dict.settings.showFingerLabels}
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={settings.showNoteNames}
                    onChange={(e) => handleChange("showNoteNames", e.target.checked)}
                    style={{ accentColor: "var(--mint, #a9d3bb)" }}
                  />
                  {dict.settings.showNoteNames}
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", cursor: "pointer" }}>
                  <input
                    id="settings-hand-shadow"
                    type="checkbox"
                    checked={settings.showHandShadow}
                    onChange={(e) => handleChange("showHandShadow", e.target.checked)}
                    style={{ accentColor: "var(--mint, #a9d3bb)" }}
                  />
                  {dict.settings.showShadow}
                </label>
              </div>
            </div>
          </div>

          {/* Section 2: Audio & Timbre */}
          <div
            style={{
              background: "var(--panel-raised, #202b25)",
              padding: "1rem",
              borderRadius: "0.6rem",
              border: "1px solid var(--border, #33423a)",
            }}
          >
            <h3 style={{ margin: "0 0 0.8rem 0", fontSize: "0.9rem", color: "var(--mint, #a9d3bb)" }}>
              {dict.settings.audio}
            </h3>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.8rem" }}>
              <div>
                <label htmlFor="settings-sound-output" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  {dict.settings.soundOutput}:
                </label>
                <select
                  id="settings-sound-output"
                  aria-describedby="settings-sound-output-note"
                  value={settings.soundOutput}
                  onChange={(e) => handleChange("soundOutput", e.target.value as "synth" | "soundfont" | "webmidi")}
                  style={{
                    width: "100%",
                    background: "#19211d",
                    color: "#edf2ed",
                    border: "1px solid var(--border, #33423a)",
                    borderRadius: "0.35rem",
                    padding: "0.4rem 0.6rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <option value="synth">{dict.settings.synth}</option>
                  <option value="soundfont">{dict.settings.soundfont}</option>
                  <option value="webmidi">{dict.settings.webMidi}</option>
                </select>
                <p id="settings-sound-output-note" style={{ margin: "0.35rem 0 0", color: "var(--muted, #9fac9f)", fontSize: "0.74rem" }}>
                  {settings.soundOutput === "synth" && "Built-in polyphonic synthesis running directly in the browser via Web Audio."}
                  {settings.soundOutput === "soundfont" && "MuseScore General is included. You can also load your own SF2 or SF3 bank; user banks stay on this device."}
                  {settings.soundOutput === "webmidi" && "Sends sub-millisecond hardware MIDI events to connected digital pianos and synthesizers."}
                </p>
              </div>

              {settings.soundOutput === "synth" && (
                <div>
                  <label htmlFor="settings-timbre" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                    {dict.settings.timbre}:
                  </label>
                  <select
                    id="settings-timbre"
                    value={settings.soundTimbre}
                    onChange={(e) => handleChange("soundTimbre", e.target.value as "acoustic" | "bright" | "warm")}
                    style={{
                      width: "100%",
                      background: "#19211d",
                      color: "#edf2ed",
                      border: "1px solid var(--border, #33423a)",
                      borderRadius: "0.35rem",
                      padding: "0.4rem 0.6rem",
                      fontSize: "0.85rem",
                    }}
                  >
                    <option value="acoustic">{dict.settings.acoustic}</option>
                    <option value="bright">{dict.settings.bright}</option>
                    <option value="warm">{dict.settings.warm}</option>
                  </select>
                </div>
              )}

              {settings.soundOutput === "soundfont" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  <label htmlFor="settings-soundfont-select" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)" }}>
                    {dict.settings.soundfont}:
                  </label>
                  {(
                    <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                      <select
                        id="settings-soundfont-select"
                        value={settings.soundfontAssetId ?? BUILTIN_SOUNDFONT_ID}
                        onChange={(e) => handleChange("soundfontAssetId", e.target.value)}
                        style={{
                          flex: 1,
                          background: "#19211d",
                          color: "#edf2ed",
                          border: "1px solid var(--border, #33423a)",
                          borderRadius: "0.35rem",
                          padding: "0.4rem 0.6rem",
                          fontSize: "0.85rem",
                        }}
                      >
                        <option value={BUILTIN_SOUNDFONT_ID}>{BUILTIN_SOUNDFONT_NAME} (included · default)</option>
                        {soundfonts.filter(sf => sf.id !== BUILTIN_SOUNDFONT_ID).map((sf) => (
                          <option key={sf.id} value={sf.id}>
                            {sf.name} ({(sf.byteLength / (1024 * 1024)).toFixed(1)} MB)
                          </option>
                        ))}
                      </select>
                      {settings.soundfontAssetId && settings.soundfontAssetId !== BUILTIN_SOUNDFONT_ID && (
                        <button
                          type="button"
                          onClick={() => handleSoundFontDelete(settings.soundfontAssetId!)}
                          title={dict.common.delete}
                          aria-label={dict.common.delete}
                          style={{
                            background: "rgba(239, 68, 68, 0.15)",
                            border: "1px solid rgba(239, 68, 68, 0.4)",
                            color: "#f87171",
                            padding: "0.4rem 0.6rem",
                            borderRadius: "0.35rem",
                            cursor: "pointer",
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  )}

                  <div style={{ marginTop: "0.3rem" }}>
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        background: "var(--panel, #19211d)",
                        border: "1px solid var(--border, #33423a)",
                        borderRadius: "0.35rem",
                        padding: "0.35rem 0.7rem",
                        color: "var(--mint, #a9d3bb)",
                        fontSize: "0.8rem",
                        cursor: sfUploading ? "wait" : "pointer",
                      }}
                    >
                      <Upload size={13} aria-hidden="true" />
                      {sfUploading ? "Importing SoundFont..." : dict.settings.uploadSoundfont}
                      <input
                        type="file"
                        accept=".sf2,.sf3"
                        disabled={sfUploading}
                        onChange={handleSoundFontUpload}
                        style={{ display: "none" }}
                      />
                    </label>
                    {sfUploading && (
                      <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", marginTop: "0.5rem" }}>
                        <progress
                          aria-label="SoundFont import progress"
                          max={sfProgress?.totalBytes || 1}
                          value={Math.min(sfProgress?.loadedBytes ?? 0, sfProgress?.totalBytes || 1)}
                          style={{ flex: 1, height: "0.55rem", accentColor: "var(--mint, #a9d3bb)" }}
                        />
                        <span aria-live="polite" style={{ color: "var(--muted, #9fac9f)", fontSize: "0.72rem", whiteSpace: "nowrap" }}>
                          {sfProgress?.phase === "hashing" ? "Hashing" : sfProgress?.phase === "saving" ? "Saving" : sfProgress?.phase === "parsing" ? "Checking bank" : "Reading"}
                          {sfProgress?.totalBytes ? ` ${Math.floor((sfProgress.loadedBytes / sfProgress.totalBytes) * 100)}%` : ""}
                        </span>
                        <button type="button" onClick={() => sfAbortController.current?.abort()} style={{ fontSize: "0.72rem" }}>
                          {dict.common.cancel}
                        </button>
                      </div>
                    )}
                  </div>
                  {sfError && (
                    <p role="alert" style={{ margin: "0.2rem 0 0", color: "#f87171", fontSize: "0.75rem" }}>
                      {sfError}
                    </p>
                  )}
                  <p className="settings-help">
                    Up to 1 GiB. Supports mono and linked stereo SF2 PCM and SF3 Ogg/Vorbis samples, decoded on demand.
                    Filter, modulation and effects processing can differ from a full SoundFont synthesizer. ROM and linked sample type 8 remain unsupported.
                    {" "}<a href={releaseAssetUrl("soundfonts/musescore-general/MuseScore_General_License.md").href} target="_blank" rel="noreferrer">MuseScore General credits and MIT license</a>.
                  </p>
                </div>
              )}

              {settings.soundOutput === "webmidi" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  <button type="button" onClick={() => {
                    const manager = getSharedWebMidiOutputManager();
                    midiManagerRef.current = manager;
                    void manager.requestPermissionFromUserGesture().then(status => {
                      setMidiStatus(status);
                      if (status.permission !== "granted") setFeedback(status.errorMessage ?? "MIDI access is not available.");
                      else setFeedback("MIDI access connected. Select an output device and channel.");
                    }).catch(error => setFeedback(error instanceof Error ? error.message : String(error)));
                  }}>Connect MIDI device</button>
                  <label htmlFor="settings-webmidi-select" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)" }}>
                    {dict.settings.webMidiOutputDevice}:
                  </label>
                  {midiStatus?.permission === "unsupported" ? (
                    <p style={{ margin: "0.2rem 0", color: "#f87171", fontSize: "0.78rem" }}>
                      Web MIDI API is not supported in this browser.
                    </p>
                  ) : midiStatus?.permission === "denied" ? (
                    <p style={{ margin: "0.2rem 0", color: "#f87171", fontSize: "0.78rem" }}>
                      MIDI access permission was denied by browser.
                    </p>
                  ) : (midiStatus?.devices.length ?? 0) === 0 ? (
                    <p style={{ margin: "0.2rem 0", color: "#facc15", fontSize: "0.78rem" }}>
                      No connected MIDI output devices found. Connect a device via USB/Bluetooth.
                    </p>
                  ) : (
                    <select
                      id="settings-webmidi-select"
                      value={settings.webMidiDeviceId ?? midiStatus?.devices[0]?.id ?? ""}
                      onChange={(e) => handleChange("webMidiDeviceId", e.target.value)}
                      style={{
                        width: "100%",
                        background: "#19211d",
                        color: "#edf2ed",
                        border: "1px solid var(--border, #33423a)",
                        borderRadius: "0.35rem",
                        padding: "0.4rem 0.6rem",
                        fontSize: "0.85rem",
                      }}
                    >
                      {midiStatus?.devices.map((dev) => (
                        <option key={dev.id} value={dev.id}>
                          {dev.name} ({dev.manufacturer})
                        </option>
                      ))}
                    </select>
                  )}
                  <label htmlFor="settings-webmidi-channel">{dict.settings.webMidiChannel}</label>
                  <select id="settings-webmidi-channel" value={settings.webMidiChannel ?? 0}
                    onChange={event => void handleChange("webMidiChannel", Number(event.target.value))}>
                    {Array.from({ length: 16 }, (_, channel) => <option key={channel} value={channel}>{channel + 1}</option>)}
                  </select>
                  <p style={{ fontSize: "0.78rem" }}>Volume is sent to the hardware as CC7. External sound is not captured for export.</p>
                </div>
              )}

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  <span>Lead-in Duration:</span>
                  <span style={{ color: "var(--mint, #a9d3bb)" }}>{settings.leadInSeconds.toFixed(1)} s</span>
                </div>
                <input
                  type="range"
                  min={-2.0}
                  max={0.0}
                  step={0.5}
                  value={settings.leadInSeconds}
                  onChange={(e) => handleChange("leadInSeconds", parseFloat(e.target.value))}
                  style={{ width: "100%", accentColor: "var(--mint, #a9d3bb)" }}
                />
              </div>
            </div>
          </div>

          {/* Section 3: Performance & Rendering */}
          <div
            style={{
              background: "var(--panel-raised, #202b25)",
              padding: "1rem",
              borderRadius: "0.6rem",
              border: "1px solid var(--border, #33423a)",
            }}
          >
            <h3 style={{ margin: "0 0 0.8rem 0", fontSize: "0.9rem", color: "var(--mint, #a9d3bb)" }}>
              {dict.settings.engine}
            </h3>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={settings.showFpsOverlay}
                  onChange={(e) => handleChange("showFpsOverlay", e.target.checked)}
                  style={{ accentColor: "var(--mint, #a9d3bb)" }}
                />
                {dict.settings.showFps}
              </label>

              <div>
                <label htmlFor="settings-calculation-engine" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  {dict.settings.calculationEngine}:
                </label>
                <select
                  id="settings-calculation-engine"
                  value={settings.calculationEngine}
                  onChange={(e) => handleChange("calculationEngine", e.target.value as CalculationEngine)}
                  style={{
                    background: "#19211d",
                    color: "#edf2ed",
                    border: "1px solid var(--border, #33423a)",
                    borderRadius: "0.35rem",
                    padding: "0.4rem 0.6rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <option value="typescript">{dict.settings.tsEngine}</option>
                  <option value="python">{dict.settings.pythonEngine}</option>
                </select>
                <p style={{ margin: "0.35rem 0 0", color: "var(--muted, #9fac9f)", fontSize: "0.74rem" }}>
                  {settings.calculationEngine === "python"
                    ? "Runs the Python calculation engine inside WebAssembly (Pyodide 314.0.7)."
                    : "Runs the native TypeScript port directly in a browser Worker without loading Pyodide."}
                </p>
              </div>

              <div>
                <label htmlFor="settings-frame-cap" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  {dict.settings.frameCap}:
                </label>
                <select
                  id="settings-frame-cap"
                  value={settings.renderCapFps}
                  onChange={(e) => handleChange("renderCapFps", parseInt(e.target.value, 10))}
                  style={{
                    background: "#19211d",
                    color: "#edf2ed",
                    border: "1px solid var(--border, #33423a)",
                    borderRadius: "0.35rem",
                    padding: "0.4rem 0.6rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <option value={60}>60 FPS (Default / Standard)</option>
                  <option value={30}>30 FPS (Power Saver / Battery)</option>
                  <option value={120}>120 FPS (High Refresh Rate)</option>
                  <option value={0}>Uncapped (Browser VSync)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Section 4: Storage Quota Inspector */}
          <div
            style={{
              background: "var(--panel-raised, #202b25)",
              padding: "1rem",
              borderRadius: "0.6rem",
              border: "1px solid var(--border, #33423a)",
            }}
          >
            <h3 style={{ margin: "0 0 0.6rem 0", fontSize: "0.9rem", color: "var(--mint, #a9d3bb)" }}>
              {dict.settings.storage}
            </h3>

            {quotaInfo ? (
              <div style={{ fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.8rem" }}>
                {dict.settings.storageQuota}: <strong style={{ color: "#edf2ed" }}>{formatBytes(quotaInfo.usageBytes)}</strong> of{" "}
                <strong style={{ color: "#edf2ed" }}>{formatBytes(quotaInfo.quotaBytes)}</strong> (
                {(quotaInfo.percentUsed * 100).toFixed(1)}% used)
              </div>
            ) : (
              <p style={{ margin: "0 0 0.8rem 0", fontSize: "0.8rem", color: "var(--muted, #9fac9f)" }}>
                IndexedDB storage active (projects, profiles, autosave sessions).
              </p>
            )}

            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={handleClearCache}
                style={{
                  padding: "0.35rem 0.75rem",
                  borderRadius: "0.35rem",
                  fontSize: "0.8rem",
                  background: "rgba(255, 255, 255, 0.08)",
                  border: "1px solid var(--border, #33423a)",
                  color: "#edf2ed",
                  cursor: "pointer",
                }}
              >
                {dict.settings.clearCache}
              </button>
              <button
                type="button"
                onClick={handleReset}
                style={{
                  padding: "0.35rem 0.75rem",
                  borderRadius: "0.35rem",
                  fontSize: "0.8rem",
                  background: "rgba(239, 68, 68, 0.15)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  color: "#f87171",
                  cursor: "pointer",
                }}
              >
                {dict.settings.resetDefaults}
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "0.85rem 1.25rem",
            borderTop: "1px solid var(--border, #33423a)",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "0.45rem 1.2rem",
              borderRadius: "0.4rem",
              background: "var(--mint, #a9d3bb)",
              border: "none",
              color: "#111714",
              fontWeight: 700,
              fontSize: "0.82rem",
              cursor: "pointer",
            }}
          >
            {dict.common.done}
          </button>
        </div>
      </div>
    </div>
  );
}
