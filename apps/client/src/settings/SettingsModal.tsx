import React, { useState, useEffect } from "react";
import {
  getSettings,
  updateSettingsPersisted,
  resetToDefaultsPersisted,
  subscribeSettings,
} from "./settingsStore";
import type { AppSettings } from "./types";
import { getStorageQuota, clearSessionSnapshot } from "../storage";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsChanged?: (settings: AppSettings) => void;
}

export function SettingsModal({ isOpen, onClose, onSettingsChanged }: SettingsModalProps) {
  const [settings, setSettings] = useState<AppSettings>(getSettings());
  const [quotaInfo, setQuotaInfo] = useState<{ usageBytes: number; quotaBytes: number; percentUsed: number } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeSettings((updated) => {
      setSettings(updated);
      onSettingsChanged?.(updated);
    });
    return unsubscribe;
  }, [onSettingsChanged]);

  useEffect(() => {
    if (isOpen) {
      void getStorageQuota().then((q) => setQuotaInfo(q));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleChange = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setStorageError(null);
    try {
      const updated = await updateSettingsPersisted({ [key]: value });
      setSettings(updated);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleReset = async () => {
    setStorageError(null);
    try {
      const defs = await resetToDefaultsPersisted();
      setSettings(defs);
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

  const formatMb = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
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
            <span style={{ fontSize: "1.2rem" }}>⚙</span>
            <h2 id="settings-modal-title" style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>
              Settings & Preferences
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--muted, #9fac9f)",
              fontSize: "1.2rem",
              cursor: "pointer",
              padding: "0.2rem 0.5rem",
            }}
          >
            ✕
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
              ✓ {feedback}
            </div>
          )}
          {storageError && (
            <div role="alert" style={{ color: "#f87171", fontSize: "0.82rem" }}>
              Change was not saved: {storageError}
            </div>
          )}

          {/* Section 1: Keyboard Geometry */}
          <div
            style={{
              background: "var(--panel-raised, #202b25)",
              padding: "1rem",
              borderRadius: "0.6rem",
              border: "1px solid var(--border, #33423a)",
            }}
          >
            <h3 style={{ margin: "0 0 0.8rem 0", fontSize: "0.9rem", color: "var(--mint, #a9d3bb)" }}>
              Keyboard Geometry & Visuals
            </h3>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div>
                <label htmlFor="settings-key-style" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  Key Width Proportions:
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
                  <option value="realistic">Realistic Key Widths (standard piano geometry)</option>
                  <option value="equal">Equal Key Widths (uniform lanes)</option>
                </select>
              </div>

              <div>
                <label htmlFor="settings-skin-style" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  Hand Skin Style:
                </label>
                <select
                  id="settings-skin-style"
                  value={settings.skinStyle}
                  onChange={(e) => handleChange("skinStyle", e.target.value as "cartoon" | "gloves" | "robot" | "skeleton" | "realistic")}
                  style={{
                    background: "#19211d",
                    color: "#edf2ed",
                    border: "1px solid var(--border, #33423a)",
                    borderRadius: "0.35rem",
                    padding: "0.4rem 0.6rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <option value="realistic">Realistic (Human Flesh & Anatomical Shading)</option>
                  <option value="cartoon">Cartoon (Flesh & Sleeve)</option>
                  <option value="gloves">White Gloves (Animated Cartoon)</option>
                  <option value="robot">Robot (Futuristic Shell)</option>
                  <option value="skeleton">Skeleton (Bare Bones & Joints)</option>
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
                  Show Finger Labels (1..5)
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={settings.showNoteNames}
                    onChange={(e) => handleChange("showNoteNames", e.target.checked)}
                    style={{ accentColor: "var(--mint, #a9d3bb)" }}
                  />
                  Show Note Names on Keys
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", cursor: "pointer" }}>
                  <input
                    id="settings-hand-shadow"
                    type="checkbox"
                    checked={settings.showHandShadow}
                    onChange={(e) => handleChange("showHandShadow", e.target.checked)}
                    style={{ accentColor: "var(--mint, #a9d3bb)" }}
                  />
                  Show Hand Drop Shadow
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
              Audio & Playback
            </h3>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.8rem" }}>
              <div>
                <label htmlFor="settings-sound-output" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  Audio Output Engine:
                </label>
                <select
                  id="settings-sound-output"
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
                  <option value="synth">Web Audio Synth (Built-in Polyphonic Sampler)</option>
                  <option value="soundfont">SoundFont SF2 Synth (Realistic Instrument Samples)</option>
                  <option value="webmidi">Web MIDI Output (External Hardware Synth / DAW)</option>
                </select>
              </div>

              <div>
                <label htmlFor="settings-timbre" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  Piano Synth Timbre:
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
                  <option value="acoustic">Acoustic Grand (Balanced)</option>
                  <option value="bright">Bright Concert (Crisp Attack)</option>
                  <option value="warm">Warm Upright (Mellow)</option>
                </select>
              </div>

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
              Rendering & Diagnostics
            </h3>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={settings.showFpsOverlay}
                  onChange={(e) => handleChange("showFpsOverlay", e.target.checked)}
                  style={{ accentColor: "var(--mint, #a9d3bb)" }}
                />
                Show FPS Performance Overlay
              </label>

              <div>
                <label htmlFor="settings-frame-cap" style={{ display: "block", fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.3rem" }}>
                  Render Rate Target:
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
              Browser Storage & Quota
            </h3>

            {quotaInfo ? (
              <div style={{ fontSize: "0.8rem", color: "var(--muted, #9fac9f)", marginBottom: "0.8rem" }}>
                Storage usage: <strong style={{ color: "#edf2ed" }}>{formatMb(quotaInfo.usageBytes)}</strong> of{" "}
                <strong style={{ color: "#edf2ed" }}>{formatMb(quotaInfo.quotaBytes)}</strong> (
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
                Clear Autosave Cache
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
                Reset to Defaults
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
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
