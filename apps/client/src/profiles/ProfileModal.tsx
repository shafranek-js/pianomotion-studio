import React, { useState, useEffect } from "react";
import { Check, UserRound, X } from "lucide-react";
import type { PianistProfile } from "@handthesia/contracts";
import {
  ANATOMY_BONES,
  BEHAVIOR_SLIDERS,
  BEHAVIOR_OPTIONS,
  DEFAULT_ANATOMY,
  type BoneId,
} from "./types";
import {
  getActiveProfile,
  setActiveProfile,
  listProfiles,
  saveProfile,
  deleteProfile,
  subscribeProfiles,
  isCanonicalProfile,
} from "./profileStore";
import { importLegacyPianistJson, exportProfileToJson } from "./legacyImporter";

export interface ProfileModalProps {
  presentation?: "dialog" | "workspace";
  initialProfile?: PianistProfile;
  isOpen: boolean;
  onClose: () => void;
  onProfileChanged?: (profile: PianistProfile) => void;
}

function projectProfileChoices(profile?: PianistProfile): PianistProfile[] {
  const stored = listProfiles();
  if (!profile) return stored;
  return stored.some(candidate => candidate.profileId === profile.profileId)
    ? stored.map(candidate => candidate.profileId === profile.profileId ? profile : candidate)
    : [...stored, profile];
}

export function ProfileModal({ isOpen, onClose, onProfileChanged, presentation = "dialog", initialProfile }: ProfileModalProps) {
  const [profiles, setProfiles] = useState<PianistProfile[]>(() => projectProfileChoices(initialProfile));
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    (initialProfile ?? getActiveProfile()).profileId,
  );
  const [activeTab, setActiveTab] = useState<"anatomy" | "behavior" | "manage">("anatomy");
  const [editingProfile, setEditingProfile] = useState<PianistProfile>(() => initialProfile ?? getActiveProfile());
  const [importError, setImportError] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [conflictProfile, setConflictProfile] = useState<PianistProfile | null>(null);

  // Sync profiles on external changes
  useEffect(() => {
    const unsubscribe = subscribeProfiles(() => {
      setProfiles(projectProfileChoices(initialProfile));
    });
    return unsubscribe;
  }, [initialProfile]);

  // Sync draft when selected profile changes
  const [prevSelectedId, setPrevSelectedId] = useState(selectedProfileId);
  if (prevSelectedId !== selectedProfileId) {
    setPrevSelectedId(selectedProfileId);
    const prof = profiles.find((p) => p.profileId === selectedProfileId) ?? getActiveProfile();
    setEditingProfile(JSON.parse(JSON.stringify(prof)));
  }

  if (!isOpen) return null;

  const isDefaultProfile = isCanonicalProfile(editingProfile.profileId);

  const handleSelectProfile = async (id: string) => {
    setOperationError(null);
    try {
      const committed = await setActiveProfile(id);
      setSelectedProfileId(committed.profileId);
      onProfileChanged?.(committed);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleBoneChange = (boneId: BoneId, value: number) => {
    setEditingProfile((prev) => ({
      ...prev,
      anatomy: {
        ...prev.anatomy,
        [boneId]: Math.max(0.1, Number(value)),
      },
    }));
  };

  const handleBehaviorChange = (key: string, value: number | string) => {
    setEditingProfile((prev) => ({
      ...prev,
      behavior: {
        ...prev.behavior,
        [key]: value,
      },
    }));
  };

  const handleSave = async () => {
    if (isDefaultProfile) return;
    setIsSaving(true);
    setOperationError(null);
    try {
      const saved = await saveProfile({ ...editingProfile, revision: editingProfile.revision + 1 });
      const active = await setActiveProfile(saved.profileId);
      setEditingProfile(active);
      setSelectedProfileId(active.profileId);
      onProfileChanged?.(active);
      setSaveFeedback("Profile saved & applied!");
      setTimeout(() => setSaveFeedback(null), 2500);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleClone = async () => {
    setIsSaving(true);
    setOperationError(null);
    try {
      // A package's profile may not exist in the global profile library yet.
      // Copy the actual session profile, including its imported anatomy.
      const now = Date.now() / 1000;
      const cloned = await saveProfile({
        ...structuredClone(editingProfile),
        profileId: crypto.randomUUID(),
        name: `${editingProfile.name} (Copy)`,
        revision: 0,
        createdAtUnixSeconds: now,
        modifiedAtUnixSeconds: now,
      });
      const active = await setActiveProfile(cloned.profileId);
      setSelectedProfileId(active.profileId);
      setSaveFeedback(`Created copy "${active.name}"`);
      onProfileChanged?.(active);
      setTimeout(() => setSaveFeedback(null), 2500);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (isDefaultProfile) return;
    const toDeleteId = editingProfile.profileId;
    setIsSaving(true);
    setOperationError(null);
    try {
      const deleted = await deleteProfile(toDeleteId);
      if (!deleted) throw new Error("This profile cannot be deleted.");
      const fallback = getActiveProfile();
      setSelectedProfileId(fallback.profileId);
      setEditingProfile(fallback);
      onProfileChanged?.(fallback);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportJson = () => {
    const jsonStr = exportProfileToJson(editingProfile);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${editingProfile.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const commitImport = async (imported: PianistProfile, resolution: "replace" | "copy") => {
    setIsSaving(true);
    setOperationError(null);
    setImportError(null);
    try {
      let toSave = imported;
      const isCanonical = isCanonicalProfile(imported.profileId);
      if (resolution === "copy" || isCanonical) {
        const now = Date.now() / 1000;
        toSave = {
          ...structuredClone(imported),
          profileId: crypto.randomUUID(),
          name: `${imported.name} (Copy)`,
          revision: 0,
          createdAtUnixSeconds: now,
          modifiedAtUnixSeconds: now,
        };
      }
      const saved = await saveProfile(toSave);
      const active = await setActiveProfile(saved.profileId);
      setSelectedProfileId(active.profileId);
      setEditingProfile(active);
      onProfileChanged?.(active);
      setSaveFeedback(
        resolution === "copy" || isCanonical
          ? `Created copy "${active.name}"`
          : `Replaced profile "${active.name}"`,
      );
      setTimeout(() => setSaveFeedback(null), 3000);
      setConflictProfile(null);
    } catch (error) {
      setImportError(String(error instanceof Error ? error.message : error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError(null);
    setOperationError(null);
    try {
      const imported = importLegacyPianistJson(await file.text());
      const existing = profiles.find((p) => p.profileId === imported.profileId);
      if (existing) {
        setConflictProfile(imported);
        return;
      }
      await commitImport(imported, "replace");
    } catch (error) {
      setImportError(String(error instanceof Error ? error.message : error));
    }
  };

  return (
    <div
      className="modal-backdrop"
      role={presentation === "dialog" ? "dialog" : undefined}
      aria-modal={presentation === "dialog" ? true : undefined}
      aria-labelledby={presentation === "dialog" ? "profile-modal-title" : undefined}
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
          maxWidth: "760px",
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
            <UserRound size={20} aria-hidden="true" />
            <h2 id="profile-modal-title" style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>
              Pianist Profiles
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
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Profile Selector Strip */}
        <div
          style={{
            padding: "0.75rem 1.25rem",
            background: "rgba(0, 0, 0, 0.2)",
            borderBottom: "1px solid var(--border, #33423a)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "0.6rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <label htmlFor="active-profile-select" style={{ fontSize: "0.82rem", color: "var(--muted, #9fac9f)" }}>
              Active Profile:
            </label>
            <select
              id="active-profile-select"
              value={selectedProfileId}
              disabled={isSaving}
              onChange={(e) => handleSelectProfile(e.target.value)}
              style={{
                background: "var(--panel-raised, #202b25)",
                color: "#edf2ed",
                border: "1px solid var(--border, #33423a)",
                borderRadius: "0.4rem",
                padding: "0.35rem 0.6rem",
                fontWeight: 600,
                fontSize: "0.85rem",
              }}
            >
              {profiles.map((p) => (
                <option key={p.profileId} value={p.profileId}>
                  {p.name} {p.profileId === "default" ? "(Built-in)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", gap: "0.4rem" }}>
            <button
              type="button"
              onClick={handleClone}
              disabled={isSaving}
              style={{
                padding: "0.3rem 0.6rem",
                borderRadius: "0.35rem",
                fontSize: "0.78rem",
                background: "rgba(255, 255, 255, 0.08)",
                border: "1px solid var(--border, #33423a)",
                color: "#edf2ed",
                cursor: "pointer",
              }}
            >
              Duplicate
            </button>
            {!isDefaultProfile && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={isSaving}
                style={{
                  padding: "0.3rem 0.6rem",
                  borderRadius: "0.35rem",
                  fontSize: "0.78rem",
                  background: "rgba(239, 68, 68, 0.15)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  color: "#f87171",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            )}
          </div>
        </div>

        {/* Tab Navigation */}
        <div
          role="tablist"
          style={{
            display: "flex",
            borderBottom: "1px solid var(--border, #33423a)",
            padding: "0 1.25rem",
            gap: "1rem",
            background: "rgba(0,0,0,0.1)",
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "anatomy"}
            onClick={() => setActiveTab("anatomy")}
            style={{
              padding: "0.65rem 0.2rem",
              background: "transparent",
              border: "none",
              borderBottom: activeTab === "anatomy" ? "2px solid var(--mint, #a9d3bb)" : "2px solid transparent",
              color: activeTab === "anatomy" ? "#edf2ed" : "var(--muted, #9fac9f)",
              fontWeight: activeTab === "anatomy" ? 700 : 500,
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            Hand Anatomy (19 Bones)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "behavior"}
            onClick={() => setActiveTab("behavior")}
            style={{
              padding: "0.65rem 0.2rem",
              background: "transparent",
              border: "none",
              borderBottom: activeTab === "behavior" ? "2px solid var(--mint, #a9d3bb)" : "2px solid transparent",
              color: activeTab === "behavior" ? "#edf2ed" : "var(--muted, #9fac9f)",
              fontWeight: activeTab === "behavior" ? 700 : 500,
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            Motion & Technique
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "manage"}
            onClick={() => setActiveTab("manage")}
            style={{
              padding: "0.65rem 0.2rem",
              background: "transparent",
              border: "none",
              borderBottom: activeTab === "manage" ? "2px solid var(--mint, #a9d3bb)" : "2px solid transparent",
              color: activeTab === "manage" ? "#edf2ed" : "var(--muted, #9fac9f)",
              fontWeight: activeTab === "manage" ? 700 : 500,
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            Import / Export
          </button>
        </div>

        {/* Tab Body */}
        <div style={{ padding: "1.25rem", overflowY: "auto", flex: 1 }}>
          {saveFeedback && (
            <div
              role="status"
              style={{
                padding: "0.5rem 0.8rem",
                borderRadius: "0.4rem",
                background: "rgba(16, 185, 129, 0.15)",
                border: "1px solid rgba(16, 185, 129, 0.4)",
                color: "#34d399",
                fontSize: "0.82rem",
                marginBottom: "1rem",
              }}
            >
              <Check size={14} aria-hidden="true" /> {saveFeedback}
            </div>
          )}

          {importError && (
            <div
              role="alert"
              style={{
                padding: "0.5rem 0.8rem",
                borderRadius: "0.4rem",
                background: "rgba(239, 68, 68, 0.15)",
                border: "1px solid rgba(239, 68, 68, 0.4)",
                color: "#f87171",
                fontSize: "0.82rem",
                marginBottom: "1rem",
              }}
            >
              {importError}
            </div>
          )}

          {operationError && (
            <div role="alert" style={{ color: "#f87171", marginBottom: "0.8rem", fontSize: "0.82rem" }}>
              Profile change was not saved: {operationError}
            </div>
          )}

          {/* Anatomy Tab */}
          {activeTab === "anatomy" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted, #9fac9f)" }}>
                Hand bone lengths in model units (1 unit ≈ 1.09 cm on standard piano key scale). Adjust to simulate smaller hands or virtuoso reach.
              </p>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
                  gap: "0.8rem",
                }}
              >
                {ANATOMY_BONES.map((bone) => {
                  const currentVal = Number(editingProfile.anatomy[bone.id] ?? DEFAULT_ANATOMY[bone.id]);
                  const pct = Math.round((currentVal / DEFAULT_ANATOMY[bone.id]) * 100);
                  return (
                    <div
                      key={bone.id}
                      style={{
                        background: "var(--panel-raised, #202b25)",
                        padding: "0.6rem 0.8rem",
                        borderRadius: "0.5rem",
                        border: "1px solid var(--border, #33423a)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: "0.78rem",
                          marginBottom: "0.3rem",
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{bone.name}</span>
                        <span style={{ color: "var(--mint, #a9d3bb)" }}>
                          {currentVal.toFixed(2)} ({pct}%)
                        </span>
                      </div>
                      <input
                        type="range"
                        aria-label={bone.name}
                        min={bone.min}
                        max={bone.max}
                        step={0.05}
                        value={currentVal}
                        onChange={(e) => handleBoneChange(bone.id, parseFloat(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--mint, #a9d3bb)" }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Behavior Tab */}
          {activeTab === "behavior" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1.2rem" }}>
              <div>
                <h3 style={{ margin: "0 0 0.6rem 0", fontSize: "0.9rem", color: "var(--mint, #a9d3bb)" }}>
                  Key Motion & Ergonomics
                </h3>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                    gap: "0.8rem",
                  }}
                >
                  {BEHAVIOR_SLIDERS.slice(0, 10).map((slider) => {
                    const currentVal = Number(editingProfile.behavior[slider.id] ?? slider.default);
                    return (
                      <div
                        key={slider.id}
                        style={{
                          background: "var(--panel-raised, #202b25)",
                          padding: "0.6rem 0.8rem",
                          borderRadius: "0.5rem",
                          border: "1px solid var(--border, #33423a)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: "0.78rem",
                            marginBottom: "0.2rem",
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>{slider.label}</span>
                          <span style={{ color: "var(--mint, #a9d3bb)" }}>
                            {currentVal.toFixed(2)}{slider.unit ? ` ${slider.unit}` : ""}
                          </span>
                        </div>
                        <input
                          type="range"
                          aria-label={slider.label}
                          min={slider.min}
                          max={slider.max}
                          step={slider.step ?? 0.01}
                          value={currentVal}
                          onChange={(e) => handleBehaviorChange(slider.id, parseFloat(e.target.value))}
                          style={{ width: "100%", accentColor: "var(--mint, #a9d3bb)" }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <h3 style={{ margin: "0 0 0.6rem 0", fontSize: "0.9rem", color: "var(--mint, #a9d3bb)" }}>
                  Technique & Model Choices
                </h3>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                    gap: "0.8rem",
                  }}
                >
                  {BEHAVIOR_OPTIONS.map((opt) => {
                    const currentVal = String(editingProfile.behavior[opt.id] ?? opt.default);
                    return (
                      <div
                        key={opt.id}
                        style={{
                          background: "var(--panel-raised, #202b25)",
                          padding: "0.6rem 0.8rem",
                          borderRadius: "0.5rem",
                          border: "1px solid var(--border, #33423a)",
                        }}
                      >
                        <label
                          htmlFor={`behavior-opt-${opt.id}`}
                          style={{ display: "block", fontSize: "0.78rem", fontWeight: 600, marginBottom: "0.3rem" }}
                        >
                          {opt.label}
                        </label>
                        <select
                          id={`behavior-opt-${opt.id}`}
                          value={currentVal}
                          onChange={(e) => handleBehaviorChange(opt.id, e.target.value)}
                          style={{
                            width: "100%",
                            background: "#19211d",
                            color: "#edf2ed",
                            border: "1px solid var(--border, #33423a)",
                            borderRadius: "0.3rem",
                            padding: "0.3rem",
                            fontSize: "0.8rem",
                          }}
                        >
                          {opt.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Manage Tab */}
          {activeTab === "manage" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1.2rem" }}>
              <div
                style={{
                  background: "var(--panel-raised, #202b25)",
                  padding: "1rem",
                  borderRadius: "0.6rem",
                  border: "1px solid var(--border, #33423a)",
                }}
              >
                <h4 style={{ margin: "0 0 0.5rem 0", fontSize: "0.9rem" }}>Import Pianist Profile (.json)</h4>
                <p style={{ margin: "0 0 0.8rem 0", fontSize: "0.8rem", color: "var(--muted, #9fac9f)" }}>
                  Upload an external pianist profile JSON file.
                </p>
                <label
                  style={{
                    display: "inline-block",
                    padding: "0.45rem 0.9rem",
                    borderRadius: "0.4rem",
                    background: "var(--mint, #a9d3bb)",
                    color: "#111714",
                    fontWeight: 600,
                    fontSize: "0.82rem",
                    cursor: "pointer",
                  }}
                >
                  Choose JSON File
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={handleImportFile}
                  disabled={isSaving}
                    style={{ display: "none" }}
                  />
                </label>
              </div>

              <div
                style={{
                  background: "var(--panel-raised, #202b25)",
                  padding: "1rem",
                  borderRadius: "0.6rem",
                  border: "1px solid var(--border, #33423a)",
                }}
              >
                <h4 style={{ margin: "0 0 0.5rem 0", fontSize: "0.9rem" }}>Export Current Profile</h4>
                <p style={{ margin: "0 0 0.8rem 0", fontSize: "0.8rem", color: "var(--muted, #9fac9f)" }}>
                  Download the currently active pianist profile as a standard JSON file.
                </p>
                <button
                  type="button"
                  onClick={handleExportJson}
                  style={{
                    padding: "0.45rem 0.9rem",
                    borderRadius: "0.4rem",
                    background: "rgba(255, 255, 255, 0.08)",
                    border: "1px solid var(--border, #33423a)",
                    color: "#edf2ed",
                    fontWeight: 600,
                    fontSize: "0.82rem",
                    cursor: "pointer",
                  }}
                >
                  Export as {editingProfile.name}.json
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "0.85rem 1.25rem",
            borderTop: "1px solid var(--border, #33423a)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: "0.78rem", color: "var(--muted, #9fac9f)" }}>
            Profile ID: <code>{editingProfile.profileId}</code> (rev {editingProfile.revision})
          </span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "0.45rem 0.9rem",
                borderRadius: "0.4rem",
                background: "transparent",
                border: "1px solid var(--border, #33423a)",
                color: "#edf2ed",
                fontSize: "0.82rem",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || isDefaultProfile}
              title={isDefaultProfile ? "Duplicate this preset before editing and saving it" : undefined}
              style={{
                padding: "0.45rem 1rem",
                borderRadius: "0.4rem",
                background: "var(--mint, #a9d3bb)",
                border: "none",
                color: "#111714",
                fontWeight: 700,
                fontSize: "0.82rem",
                cursor: "pointer",
              }}
            >
              Save & Apply
            </button>
          </div>
        </div>

        {conflictProfile && (
          <div
            className="conflict-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="conflict-dialog-title"
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.85)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1100,
              padding: "1rem",
              borderRadius: "0.85rem",
            }}
          >
            <div
              style={{
                background: "var(--panel, #19211d)",
                border: "1px solid var(--border, #33423a)",
                borderRadius: "0.6rem",
                padding: "1.25rem",
                maxWidth: "460px",
                width: "100%",
                display: "flex",
                flexDirection: "column",
                gap: "1rem",
                color: "#edf2ed",
                boxShadow: "0 20px 40px rgba(0,0,0,0.7)",
              }}
            >
              <h3 id="conflict-dialog-title" style={{ margin: 0, fontSize: "1.05rem", color: "#f59e0b" }}>
                ⚠️ Profile ID Conflict
              </h3>
              <p style={{ margin: 0, fontSize: "0.88rem", color: "#d1d5db", lineHeight: 1.4 }}>
                A profile with ID <code>{conflictProfile.profileId}</code> already exists in your library
                {isCanonicalProfile(conflictProfile.profileId) ? " and is a protected built-in canonical profile." : "."}
              </p>
              <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted, #9fac9f)" }}>
                {isCanonicalProfile(conflictProfile.profileId)
                  ? "Built-in profiles cannot be overwritten. A copy will be created."
                  : "Would you like to create a new copy or replace the existing profile?"}
              </p>
              <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "0.5rem" }}>
                <button
                  type="button"
                  id="conflict-cancel-btn"
                  onClick={() => setConflictProfile(null)}
                  style={{
                    padding: "0.45rem 0.85rem",
                    borderRadius: "0.35rem",
                    border: "1px solid var(--border, #33423a)",
                    background: "transparent",
                    color: "#edf2ed",
                    fontSize: "0.82rem",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                {!isCanonicalProfile(conflictProfile.profileId) && (
                  <button
                    type="button"
                    id="conflict-replace-btn"
                    onClick={() => void commitImport(conflictProfile, "replace")}
                    style={{
                      padding: "0.45rem 0.85rem",
                      borderRadius: "0.35rem",
                      border: "1px solid #ef4444",
                      background: "rgba(239, 68, 68, 0.15)",
                      color: "#ef4444",
                      fontSize: "0.82rem",
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    Replace
                  </button>
                )}
                <button
                  type="button"
                  id="conflict-copy-btn"
                  autoFocus
                  onClick={() => void commitImport(conflictProfile, "copy")}
                  style={{
                    padding: "0.45rem 0.95rem",
                    borderRadius: "0.35rem",
                    border: "none",
                    background: "var(--accent, #3b82f6)",
                    color: "#ffffff",
                    fontSize: "0.82rem",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  Create Copy (Default)
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
