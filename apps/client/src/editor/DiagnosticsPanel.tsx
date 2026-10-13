import React from "react";
import type { PlanDiagnostic } from "@handthesia/contracts";
import type { DifficultyReport } from "./types";

export interface DiagnosticsPanelProps {
  difficulty: DifficultyReport;
  diagnostics?: PlanDiagnostic[];
  onSelectNote?: (noteId: string) => void;
  className?: string;
}

const TIER_COLORS: Record<DifficultyReport["tier"], { bg: string; text: string; border: string }> = {
  Beginner: { bg: "rgba(16, 185, 129, 0.15)", text: "#34d399", border: "rgba(16, 185, 129, 0.4)" },
  Intermediate: { bg: "rgba(59, 130, 246, 0.15)", text: "#60a5fa", border: "rgba(59, 130, 246, 0.4)" },
  Advanced: { bg: "rgba(245, 158, 11, 0.15)", text: "#fbbf24", border: "rgba(245, 158, 11, 0.4)" },
  Virtuoso: { bg: "rgba(236, 72, 153, 0.15)", text: "#f472b6", border: "rgba(236, 72, 153, 0.4)" },
};

const SEVERITY_COLORS: Record<"info" | "warning" | "error", { bg: string; text: string; border: string }> = {
  error: { bg: "rgba(239, 68, 68, 0.15)", text: "#f87171", border: "rgba(239, 68, 68, 0.4)" },
  warning: { bg: "rgba(245, 158, 11, 0.15)", text: "#fbbf24", border: "rgba(245, 158, 11, 0.4)" },
  info: { bg: "rgba(59, 130, 246, 0.15)", text: "#60a5fa", border: "rgba(59, 130, 246, 0.4)" },
};

/**
 * Diagnostics & Difficulty Panel component.
 * Displays difficulty rating, ergonomic metrics, and engine/plan diagnostics with note jumping.
 */
export function DiagnosticsPanel({
  difficulty,
  diagnostics = [],
  onSelectNote,
  className = "",
}: DiagnosticsPanelProps) {
  const tierStyle = TIER_COLORS[difficulty.tier] || TIER_COLORS.Beginner;

  return (
    <div
      className={`diagnostics-panel ${className}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.2rem",
        background: "var(--panel, #19211d)",
        border: "1px solid var(--border, #33423a)",
        borderRadius: "0.75rem",
        padding: "1.2rem",
        color: "#edf2ed",
        fontSize: "0.875rem",
      }}
    >
      {/* --- Difficulty Section --- */}
      <div
        className="difficulty-card"
        style={{
          background: "var(--panel-raised, #202b25)",
          border: "1px solid var(--border, #33423a)",
          borderRadius: "0.6rem",
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.1rem", fontWeight: 700 }}>Piece Difficulty</span>
            <span style={{ fontSize: "1.4rem", fontWeight: 800, color: "var(--mint, #a9d3bb)" }}>
              {difficulty.overallScore.toFixed(1)}
              <span style={{ fontSize: "0.85rem", fontWeight: 400, color: "var(--muted, #9fac9f)" }}> / 10</span>
            </span>
          </div>
          <span
            className="tier-badge"
            style={{
              padding: "0.25rem 0.65rem",
              borderRadius: "999px",
              fontSize: "0.75rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              background: tierStyle.bg,
              color: tierStyle.text,
              border: `1px solid ${tierStyle.border}`,
            }}
          >
            {difficulty.tier}
          </span>
        </div>

        <p style={{ margin: 0, color: "var(--muted, #9fac9f)", fontSize: "0.8rem", lineHeight: 1.4 }}>
          {difficulty.summary}
        </p>

        {/* Metrics Grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: "0.6rem",
            marginTop: "0.25rem",
          }}
        >
          <div
            style={{
              background: "rgba(0, 0, 0, 0.2)",
              borderRadius: "0.4rem",
              padding: "0.5rem",
              border: "1px solid rgba(255, 255, 255, 0.05)",
            }}
          >
            <div style={{ fontSize: "0.7rem", color: "var(--muted, #9fac9f)", textTransform: "uppercase" }}>Max Stretch</div>
            <div style={{ fontSize: "1.05rem", fontWeight: 700, marginTop: "0.15rem" }}>
              {difficulty.maxStretchSemitones} <span style={{ fontSize: "0.7rem", fontWeight: 400 }}>st</span>
            </div>
          </div>

          <div
            style={{
              background: "rgba(0, 0, 0, 0.2)",
              borderRadius: "0.4rem",
              padding: "0.5rem",
              border: "1px solid rgba(255, 255, 255, 0.05)",
            }}
          >
            <div style={{ fontSize: "0.7rem", color: "var(--muted, #9fac9f)", textTransform: "uppercase" }}>Peak Speed</div>
            <div style={{ fontSize: "1.05rem", fontWeight: 700, marginTop: "0.15rem" }}>
              {difficulty.maxSpeedNotesPerSec} <span style={{ fontSize: "0.7rem", fontWeight: 400 }}>n/s</span>
            </div>
          </div>

          <div
            style={{
              background: "rgba(0, 0, 0, 0.2)",
              borderRadius: "0.4rem",
              padding: "0.5rem",
              border: "1px solid rgba(255, 255, 255, 0.05)",
            }}
          >
            <div style={{ fontSize: "0.7rem", color: "var(--muted, #9fac9f)", textTransform: "uppercase" }}>Crossings</div>
            <div style={{ fontSize: "1.05rem", fontWeight: 700, marginTop: "0.15rem" }}>
              {difficulty.handCrossingsCount}
            </div>
          </div>

          <div
            style={{
              background: "rgba(0, 0, 0, 0.2)",
              borderRadius: "0.4rem",
              padding: "0.5rem",
              border: "1px solid rgba(255, 255, 255, 0.05)",
            }}
          >
            <div style={{ fontSize: "0.7rem", color: "var(--muted, #9fac9f)", textTransform: "uppercase" }}>Awkward</div>
            <div style={{ fontSize: "1.05rem", fontWeight: 700, marginTop: "0.15rem" }}>
              {difficulty.awkwardFingeringCount}
            </div>
          </div>
        </div>
      </div>

      {/* --- Diagnostics List Section --- */}
      <div className="diagnostics-section" style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>
            Diagnostics ({diagnostics.length})
          </span>
        </div>

        {diagnostics.length === 0 ? (
          <div
            style={{
              padding: "1rem",
              borderRadius: "0.5rem",
              background: "rgba(16, 185, 129, 0.08)",
              border: "1px dashed rgba(16, 185, 129, 0.3)",
              color: "#34d399",
              fontSize: "0.8rem",
              textAlign: "center",
            }}
          >
            ✓ No issues detected. Fingering is playable and ergonomic.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxHeight: "280px", overflowY: "auto" }}>
            {diagnostics.map((diag, idx) => {
              const sev = SEVERITY_COLORS[diag.severity] || SEVERITY_COLORS.info;
              return (
                <div
                  key={`${diag.code}-${idx}`}
                  style={{
                    background: "var(--panel-raised, #202b25)",
                    border: "1px solid var(--border, #33423a)",
                    borderRadius: "0.5rem",
                    padding: "0.75rem",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.4rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <span
                        style={{
                          fontSize: "0.68rem",
                          fontWeight: 700,
                          padding: "0.15rem 0.45rem",
                          borderRadius: "0.25rem",
                          textTransform: "uppercase",
                          background: sev.bg,
                          color: sev.text,
                          border: `1px solid ${sev.border}`,
                        }}
                      >
                        {diag.severity}
                      </span>
                      <span style={{ fontSize: "0.75rem", fontFamily: "monospace", color: "var(--muted, #9fac9f)" }}>
                        {diag.code}
                      </span>
                    </div>

                    {diag.noteIds && diag.noteIds.length > 0 && onSelectNote && (
                      <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                        {diag.noteIds.map((nid) => (
                          <button
                            key={nid}
                            type="button"
                            onClick={() => onSelectNote(nid)}
                            style={{
                              padding: "0.2rem 0.45rem",
                              borderRadius: "0.3rem",
                              fontSize: "0.7rem",
                              background: "rgba(59, 130, 246, 0.2)",
                              border: "1px solid rgba(59, 130, 246, 0.4)",
                              color: "#93c5fd",
                              cursor: "pointer",
                            }}
                            title={`Jump to note ${nid}`}
                          >
                            Jump to {nid}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <p style={{ margin: 0, fontSize: "0.8rem", color: "#edf2ed" }}>
                    {diag.message}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
