import React, { useState, useRef, useEffect } from "react";
import {
  getVideoDimensions,
  RESOLUTION_PRESETS,
} from "./videoDimensions";
import {
  VideoExporter,
  queryVideoCodecCapabilities,
  type VideoExportResult,
  type VideoCodecCapability,
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

function idleProgress(): VideoExportProgress {
  return {
    phase: "idle", doneFrames: 0, totalFrames: 0, frameProgress: 0,
    audioProgress: 0, muxProgress: 0, overallProgress: 0,
    statusText: "Ready to export video.", etaSeconds: null,
  };
}

export function VideoExportModal({ isOpen, onClose, dataSource }: VideoExportModalProps) {
  const [preset, setPreset] = useState<ExportResolutionPreset>("1080p");
  const [fps, setFps] = useState<30 | 60>(30);
  const [format, setFormat] = useState<"mp4" | "webm">("mp4");
  const [includeAudio, setIncludeAudio] = useState(true);
  const [audioSource, setAudioSource] = useState<"synth" | "soundfont" | "recording">("synth");
  const [progress, setProgress] = useState<VideoExportProgress>(idleProgress);
  const [exportResult, setExportResult] = useState<VideoExportResult | null>(null);
  const [codecCapabilities, setCodecCapabilities] = useState<Record<"mp4" | "webm", VideoCodecCapability> | null>(null);

  const exporterRef = useRef<VideoExporter | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hasRecording = Boolean(dataSource?.audioRecording);
  const hasSoundFont = Boolean(
    dataSource?.sourceIdentity?.activeOutputId === "soundfont" &&
    dataSource.sourceIdentity.soundFontAssetId &&
    ((dataSource.sourceIdentity.soundFontAssetBlob?.size ?? 0) > 0 ||
      (dataSource.sourceIdentity.soundFontAssetBytes?.byteLength ?? 0) > 0),
  );

  const dims = getVideoDimensions(preset, window.innerWidth, window.innerHeight);

  // Set default audio source depending on whether recorded audio is loaded
  useEffect(() => {
    if (isOpen) {
      setAudioSource(hasSoundFont ? "soundfont" : hasRecording ? "recording" : "synth");
    }
  }, [isOpen, hasRecording, hasSoundFont]);

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

  useEffect(() => {
    if (!isOpen) {
      setCodecCapabilities(null);
      return;
    }
    let current = true;
    setCodecCapabilities(null);
    void queryVideoCodecCapabilities({ width: dims.width, height: dims.height, fps, includeAudio })
      .then((capabilities) => {
        if (!current) return;
        setCodecCapabilities(capabilities);
        setFormat((selected) => capabilities[selected].supported
          ? selected
          : capabilities.mp4.supported ? "mp4" : "webm");
      });
    return () => { current = false; };
  }, [isOpen, dims.width, dims.height, fps, includeAudio]);

  useEffect(() => {
    if (!isOpen) return;
    setProgress(idleProgress());
    setExportResult(null);
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = modalRef.current;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    queueMicrotask(() => focusables()[0]?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (exporterRef.current?.isRunning()) exporterRef.current.cancel();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { event.preventDefault(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // A disabled/replaced Start button can move focus to body during export.
    // Capture at document level so Escape and the focus trap still work there.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      exporterRef.current?.cancel();
      exporterRef.current = null;
      if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
      else document.querySelector<HTMLButtonElement>('button[aria-label="Export"]')?.focus({ preventScroll: true });
    };
  }, [isOpen]);

  if (!isOpen) return null;

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
      format,
      includeAudio,
      audioSource: includeAudio ? audioSource : "none",
      tailSeconds: 1.5,
    };

    try {
      const result = await exporter.exportVideo(dataSource, options, (p) => {
        if (exporterRef.current === exporter) setProgress(p);
      });
      if (exporterRef.current === exporter) setExportResult(result);
    } catch (err: unknown) {
      if (exporterRef.current !== exporter) return;
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
    if (!exportResult?.boundedBlob) return;
    const url = URL.createObjectURL(exportResult.boundedBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportResult.filename;
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

  const selectedCapability = codecCapabilities?.[format] ?? null;
  const capabilityContext = `${dims.width} × ${dims.height} at ${fps} FPS${includeAudio ? " with audio" : " without audio"}`;
  const canStart = Boolean(dataSource && selectedCapability?.supported && !isRunning);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="video-export-modal-title"
      ref={modalRef}
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
                <option value={30}>30 FPS (Recommended)</option>
                <option value={60}>60 FPS (Fluid / High Quality)</option>
              </select>
            </div>

            {/* Video Format */}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              <label htmlFor="export-format-select" style={{ fontSize: "0.85rem", color: "var(--muted, #9fac9f)" }}>
                Format
              </label>
              <select
                id="export-format-select"
                disabled={isRunning || !codecCapabilities}
                value={format}
                onChange={(e) => setFormat(e.target.value as "mp4" | "webm")}
                style={{
                  background: "var(--bg, #121815)",
                  color: "#edf2ed",
                  border: "1px solid var(--border, #33423a)",
                  borderRadius: "0.4rem",
                  padding: "0.4rem 0.6rem",
                  fontSize: "0.85rem",
                }}
              >
                <option value="mp4" disabled={codecCapabilities !== null && !codecCapabilities.mp4.supported}>
                  MP4 (H.264 / AAC){codecCapabilities?.mp4.supported ? " — supported" : ""}
                </option>
                <option value="webm" disabled={codecCapabilities !== null && !codecCapabilities.webm.supported}>
                  WebM (VP9/VP8 / Opus){codecCapabilities?.webm.supported ? " — supported" : ""}
                </option>
              </select>
              <span id="export-format-capability" role="status" style={{ fontSize: "0.72rem", color: "var(--muted, #9fac9f)" }}>
                {!codecCapabilities
                  ? "Checking encoder support for these dimensions, frame rate, and audio settings…"
                  : selectedCapability?.supported
                    ? `${format.toUpperCase()} encoding is available for ${capabilityContext}.`
                    : `Checked ${format.toUpperCase()} for ${capabilityContext}: ${selectedCapability?.reason ?? "This video format is unsupported."}`}
                {codecCapabilities && !codecCapabilities[format === "mp4" ? "webm" : "mp4"].supported && (
                  ` ${format === "mp4" ? "WebM" : "MP4"} unavailable: ${codecCapabilities[format === "mp4" ? "webm" : "mp4"].reason}`
                )}
              </span>
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
                  onChange={(e) => setAudioSource(e.target.value as "synth" | "soundfont" | "recording")}
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
                  {hasSoundFont && <option value="soundfont">Loaded SoundFont</option>}
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
            <span>Format: <strong>{format.toUpperCase()}</strong></span>
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
              {exportResult.boundedBlob ? (
                <button
                  type="button" id="download-video-btn" onClick={handleDownloadVideo}
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
              ) : (
                <span id="saved-video-file">Saved {exportResult.savedFile?.name} ({Math.ceil(exportResult.sizeBytes / (1024 * 1024))} MiB)</span>
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
                disabled={!canStart}
                onClick={() => void handleStartExport()}
                style={{
                  padding: "0.45rem 1.2rem",
                  borderRadius: "0.4rem",
                  fontSize: "0.85rem",
                  background: canStart ? "#3b82f6" : "#4b5563",
                  border: "none",
                  color: "#ffffff",
                  cursor: canStart ? "pointer" : "not-allowed",
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
