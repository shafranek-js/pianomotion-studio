import React, { useState, useRef, useEffect } from "react";
import {
  getVideoDimensions,
  RESOLUTION_PRESETS,
} from "./videoDimensions";
import {
  VideoExporter,
  type VideoExportResult,
} from "./videoExporter";
import type {
  ExportResolutionPreset,
  ExportSceneDataSource,
  VideoExportOptions,
  VideoExportProgress,
} from "./types";

export interface VideoExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  dataSource: ExportSceneDataSource | null;
}

export function VideoExportModal({ isOpen, onClose, dataSource }: VideoExportModalProps) {
  const [preset, setPreset] = useState<ExportResolutionPreset>("1080p");
  const [fps, setFps] = useState<30 | 60>(60);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [audioSource, setAudioSource] = useState<"synth" | "recording" | "none">("synth");
  const [progress, setProgress] = useState<VideoExportProgress>({
    phase: "idle",
    doneFrames: 0,
    totalFrames: 0,
    frameProgress: 0,
    audioProgress: 0,
    muxProgress: 0,
    overallProgress: 0,
    statusText: "Ready to export video.",
    etaSeconds: null,
  });
  const [exportResult, setExportResult] = useState<VideoExportResult | null>(null);

  const exporterRef = useRef<VideoExporter | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const hasRecording = Boolean(dataSource?.audioRecording);

  // Set default audio source depending on whether recorded audio is loaded
  useEffect(() => {
    if (isOpen) {
      setAudioSource(hasRecording ? "recording" : "synth");
    }
  }, [isOpen, hasRecording]);

  // Mirror preview canvas frames onto thumbnail
  useEffect(() => {
    if (progress.previewCanvas && previewCanvasRef.current) {
      const thumb = previewCanvasRef.current;
      const ctx = thumb.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, thumb.width, thumb.height);
        ctx.drawImage(progress.previewCanvas, 0, 0, thumb.width, thumb.height);
      }
    }
  }, [progress.previewCanvas, progress.doneFrames]);

  if (!isOpen) return null;

  const dims = getVideoDimensions(preset, window.innerWidth, window.innerHeight);
  const isRunning = progress.phase === "preparing" ||
                    progress.phase === "rendering_frames" ||
                    progress.phase === "rendering_audio" ||
                    progress.phase === "multiplexing";

  const handleStartExport = async () => {
    if (!dataSource || isRunning) return;

    setExportResult(null);
    const exporter = new VideoExporter();
    exporterRef.current = exporter;

    const options: VideoExportOptions = {
      preset,
      width: dims.width,
      height: dims.height,
      fps,
      speed: 1.0,
      includeAudio,
      audioSource: includeAudio ? audioSource : "none",
      tailSeconds: 1.5,
    };

    try {
      const result = await exporter.exportVideo(dataSource, options, (p) => {
        setProgress(p);
      });
      setExportResult(result);
    } catch (err: unknown) {
      if (exporter.isCancelled()) {
        setProgress((prev) => ({
          ...prev,
          phase: "cancelled",
          statusText: "Export cancelled by user.",
        }));
      } else {
        setProgress((prev) => ({
          ...prev,
          phase: "error",
          statusText: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  };

  const handleCancelExport = () => {
    if (exporterRef.current) {
      exporterRef.current.cancel();
    }
  };

  const handleDownloadVideo = () => {
    if (!exportResult) return;
    const url = URL.createObjectURL(exportResult.videoBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportResult.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const handleDownloadAudio = () => {
    if (!exportResult?.audioWavBlob) return;
    const url = URL.createObjectURL(exportResult.audioWavBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportResult.filename.replace(/\.[^.]+$/, ".wav");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const handleClose = () => {
    if (isRunning) {
      handleCancelExport();
    }
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="video-export-modal-title"
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
          maxWidth: "600px",
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
          <h2
            id="video-export-modal-title"
            style={{ margin: 0, fontSize: "1.15rem", color: "var(--mint, #a9d3bb)" }}
          >
            🎥 Export Performance Video
          </h2>
          <button
            type="button"
            id="export-close-x-btn"
            onClick={handleClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--muted, #9fac9f)",
              fontSize: "1.25rem",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "1.25rem", overflowY: "auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
          {/* Options Grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.75rem",
              background: "var(--panel-raised, #202b25)",
              padding: "1rem",
              borderRadius: "0.6rem",
              border: "1px solid var(--border, #33423a)",
            }}
          >
            {/* Resolution */}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              <label htmlFor="export-resolution-select" style={{ fontSize: "0.85rem", color: "var(--muted, #9fac9f)" }}>
                Resolution Preset
              </label>
              <select
                id="export-resolution-select"
                disabled={isRunning}
                value={preset}
                onChange={(e) => setPreset(e.target.value as ExportResolutionPreset)}
                style={{
                  background: "var(--bg, #121815)",
                  color: "#edf2ed",
                  border: "1px solid var(--border, #33423a)",
                  borderRadius: "0.4rem",
                  padding: "0.4rem 0.6rem",
                  fontSize: "0.85rem",
                }}
              >
                {Object.entries(RESOLUTION_PRESETS).map(([key, val]) => (
                  <option key={key} value={key}>
                    {key === "window" ? "Window / Custom" : val.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Frame Rate */}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              <label htmlFor="export-fps-select" style={{ fontSize: "0.85rem", color: "var(--muted, #9fac9f)" }}>
                Frame Rate
              </label>
              <select
                id="export-fps-select"
                disabled={isRunning}
                value={fps}
                onChange={(e) => setFps(parseInt(e.target.value, 10) as 30 | 60)}
                style={{
                  background: "var(--bg, #121815)",
                  color: "#edf2ed",
                  border: "1px solid var(--border, #33423a)",
                  borderRadius: "0.4rem",
                  padding: "0.4rem 0.6rem",
                  fontSize: "0.85rem",
                }}
              >
                <option value={60}>60 FPS (Fluid / High Quality)</option>
                <option value={30}>30 FPS (Faster Export)</option>
              </select>
            </div>

            {/* Audio Toggle */}
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.5rem" }}>
              <input
                type="checkbox"
                id="export-audio-checkbox"
                disabled={isRunning}
                checked={includeAudio}
                onChange={(e) => setIncludeAudio(e.target.checked)}
                style={{ width: "1rem", height: "1rem", accentColor: "var(--accent, #3b82f6)" }}
              />
              <label htmlFor="export-audio-checkbox" style={{ fontSize: "0.85rem", cursor: "pointer" }}>
                Include Master Audio
              </label>
            </div>

            {/* Audio Source */}
            {includeAudio && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.2rem" }}>
                <select
                  id="export-audio-source-select"
                  disabled={isRunning}
                  value={audioSource}
                  onChange={(e) => setAudioSource(e.target.value as "synth" | "recording" | "none")}
                  style={{
                    background: "var(--bg, #121815)",
                    color: "#edf2ed",
                    border: "1px solid var(--border, #33423a)",
                    borderRadius: "0.4rem",
                    padding: "0.35rem 0.5rem",
                    fontSize: "0.8rem",
                  }}
                >
                  <option value="synth">Synthesizer (Pianist Voice)</option>
                  {dataSource?.audioRecording && (
                    <option value="recording">Synchronized Audio Recording</option>
                  )}
                </select>
              </div>
            )}
          </div>

          {/* Export Dimensions Badge */}
          <div style={{ fontSize: "0.8rem", color: "var(--muted, #9fac9f)", display: "flex", gap: "1rem" }}>
            <span>Target Size: <strong>{dims.width} × {dims.height}</strong></span>
            <span>Speed: <strong>1.0x</strong></span>
            <span>Tail Lead-out: <strong>1.5s</strong></span>
          </div>

          {/* Progress & Live Preview */}
          <div
            style={{
              background: "var(--panel-raised, #202b25)",
              padding: "1rem",
              borderRadius: "0.6rem",
              border: "1px solid var(--border, #33423a)",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span id="export-status-text" style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                {progress.statusText}
              </span>
              {progress.etaSeconds !== null && progress.etaSeconds > 0 && (
                <span id="export-eta-text" style={{ fontSize: "0.8rem", color: "var(--muted, #9fac9f)" }}>
                  ETA: {progress.etaSeconds}s
                </span>
              )}
            </div>

            {/* Progress bar */}
            <progress
              id="export-progress-bar"
              value={progress.overallProgress}
              max={1}
              style={{
                width: "100%",
                height: "10px",
                accentColor: "var(--accent, #3b82f6)",
                borderRadius: "5px",
              }}
            />

            {/* Live frame thumbnail */}
            <div style={{ display: "flex", justifyContent: "center" }}>
              <canvas
                id="export-preview-canvas"
                ref={previewCanvasRef}
                width={240}
                height={135}
                style={{
                  width: "240px",
                  height: "135px",
                  background: "#121216",
                  borderRadius: "0.4rem",
                  border: "1px solid var(--border, #33423a)",
                }}
              />
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div
          style={{
            padding: "1rem 1.25rem",
            borderTop: "1px solid var(--border, #33423a)",
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.75rem",
          }}
        >
          {isRunning ? (
            <button
              type="button"
              id="cancel-export-btn"
              onClick={handleCancelExport}
              style={{
                padding: "0.45rem 1rem",
                borderRadius: "0.4rem",
                fontSize: "0.85rem",
                background: "#ef4444",
                border: "none",
                color: "#ffffff",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              ✕ Cancel Export
            </button>
          ) : progress.phase === "completed" && exportResult ? (
            <>
              <button
                type="button"
                id="download-video-btn"
                onClick={handleDownloadVideo}
                style={{
                  padding: "0.45rem 1.2rem",
                  borderRadius: "0.4rem",
                  fontSize: "0.85rem",
                  background: "#10b981",
                  border: "none",
                  color: "#ffffff",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                ⬇ Download Video
              </button>
              {exportResult.audioWavBlob && (
                <button
                  type="button"
                  id="download-audio-btn"
                  onClick={handleDownloadAudio}
                  style={{
                    padding: "0.45rem 1rem",
                    borderRadius: "0.4rem",
                    fontSize: "0.85rem",
                    background: "rgba(255, 255, 255, 0.1)",
                    border: "1px solid var(--border, #33423a)",
                    color: "#edf2ed",
                    cursor: "pointer",
                  }}
                >
                  ⬇ Download WAV
                </button>
              )}
              <button
                type="button"
                id="export-close-btn"
                onClick={handleClose}
                style={{
                  padding: "0.45rem 1rem",
                  borderRadius: "0.4rem",
                  fontSize: "0.85rem",
                  background: "transparent",
                  border: "1px solid var(--border, #33423a)",
                  color: "#edf2ed",
                  cursor: "pointer",
                }}
              >
                Close
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                id="export-close-btn"
                onClick={handleClose}
                style={{
                  padding: "0.45rem 1rem",
                  borderRadius: "0.4rem",
                  fontSize: "0.85rem",
                  background: "transparent",
                  border: "1px solid var(--border, #33423a)",
                  color: "#edf2ed",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                id="start-export-btn"
                disabled={!dataSource}
                onClick={() => void handleStartExport()}
                style={{
                  padding: "0.45rem 1.2rem",
                  borderRadius: "0.4rem",
                  fontSize: "0.85rem",
                  background: dataSource ? "#3b82f6" : "#4b5563",
                  border: "none",
                  color: "#ffffff",
                  cursor: dataSource ? "pointer" : "not-allowed",
                  fontWeight: 600,
                }}
              >
                🎥 Start Export
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
