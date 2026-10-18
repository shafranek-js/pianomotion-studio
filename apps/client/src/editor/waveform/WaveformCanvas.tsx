import React, { useCallback, useEffect, useRef, useState } from "react";
import type { DecodedAudioRecording } from "../../audio/recording/audioDecoder.ts";
import { calculateDragOffset } from "../../audio/recording/waveformGenerator.ts";
import { drawWaveformColumns } from "./waveformCanvasRenderer.ts";

export interface WaveformCanvasProps {
  recording: DecodedAudioRecording | null;
  offsetSeconds: number;
  songDuration: number;
  pixelsPerSecond: number;
  scrollX: number;
  onOffsetChange: (newOffset: number) => void;
  height?: number; // default 56px matching desktop WAVE_H
  /** @deprecated Kept for callers; waveform alignment follows song time. */
  speed?: number;
  currentTime?: number;
  className?: string;
  style?: React.CSSProperties;
}

// Visual constants matching desktop audio_sync.py and main.py
const BAR_BG = "#2c2c36"; // rgb(44, 44, 54)
const BAR_FILL = "#74c440"; // rgb(116, 196, 64)
const PANEL_EDGE = "#4e4e60"; // rgb(78, 78, 96)
const TEXT_COLOR = "#dcdee4"; // rgb(220, 220, 228)
const TEXT_DIM = "#787888"; // rgb(120, 120, 136)

/**
 * Interactive canvas component rendering the audio waveform aligned with the song timeline.
 * Supports horizontal dragging with 100ms coarse steps and Shift-held 10ms fine adjustment.
 */
export function WaveformCanvas({
  recording,
  offsetSeconds,
  songDuration,
  pixelsPerSecond,
  scrollX,
  onOffsetChange,
  height = 56,
  speed = 1.0,
  currentTime,
  className = "",
  style = {},
}: WaveformCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [containerWidth, setContainerWidth] = useState<number>(800);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const dragStartRef = useRef<{ startX: number; startOffset: number } | null>(null);

  // Measure container width responsively
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0) {
        setContainerWidth(Math.floor(rect.width));
      }
    };

    updateWidth();

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setContainerWidth(Math.floor(entry.contentRect.width));
        }
      }
    });

    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Redraw canvas
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const w = containerWidth;
    const h = height;

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Fill background
    ctx.fillStyle = BAR_BG;
    ctx.fillRect(0, 0, w, h);

    const pps = Math.max(1e-6, pixelsPerSecond);

    // 2. Draw waveform if recording is loaded
    if (recording && recording.peaks.length > 0 && recording.durationSeconds > 0) {
      ctx.beginPath();
      drawWaveformColumns({
        context: ctx,
        recording,
        width: w,
        height: h,
        offsetSeconds,
        songDuration,
        pixelsPerSecond,
        scrollX,
        speed,
      });
    }

    // 3. Draw playhead / current time indicator if specified
    if (currentTime !== undefined) {
      const playheadX = Math.round(currentTime * pps - scrollX);
      if (playheadX >= 0 && playheadX <= w) {
        ctx.fillStyle = BAR_FILL;
        ctx.fillRect(playheadX - 1, 0, 2, h);
      }
    }

    // 4. Bottom border line
    ctx.fillStyle = PANEL_EDGE;
    ctx.fillRect(0, h - 1, w, 1);

    // 5. Text info label overlay
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textBaseline = "top";

    if (recording) {
      const name = recording.filename ? `${recording.filename}   ` : "";
      const durStr = `${recording.durationSeconds.toFixed(1)}s`;
      const offsetSign = offsetSeconds >= 0 ? "+" : "";
      const offsetStr = `offset ${offsetSign}${offsetSeconds.toFixed(2)}s`;
      const hint = isDragging
        ? " (dragging... Shift for 10ms)"
        : " (drag to adjust, Shift: 10ms)";

      // Draw subtle shadow
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fillText(`${name}${durStr}   ${offsetStr}${hint}`, 9, 5);

      ctx.fillStyle = TEXT_COLOR;
      ctx.fillText(`${name}${durStr}   ${offsetStr}`, 8, 4);

      const mainTextWidth = ctx.measureText(`${name}${durStr}   ${offsetStr}`).width;
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(hint, 8 + mainTextWidth, 4);
    } else {
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText("No audio recording loaded (drop or choose WAV, MP3, OGG, FLAC)", 8, 4);
    }

    ctx.restore();
  }, [
    containerWidth,
    height,
    recording,
    offsetSeconds,
    songDuration,
    pixelsPerSecond,
    scrollX,
    speed,
    currentTime,
    isDragging,
  ]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // Pointer event handlers for interactive drag
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return; // primary button only
    e.currentTarget.setPointerCapture(e.pointerId);

    dragStartRef.current = {
      startX: e.clientX,
      startOffset: offsetSeconds,
    };
    setIsDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStartRef.current || !isDragging) return;

    const deltaX = e.clientX - dragStartRef.current.startX;
    const newOffset = calculateDragOffset(
      dragStartRef.current.startOffset,
      deltaX,
      pixelsPerSecond,
      e.shiftKey,
    );

    onOffsetChange(newOffset);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragStartRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Safe ignore
      }
      dragStartRef.current = null;
      setIsDragging(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className={`waveform-canvas-container ${className}`}
      style={{
        width: "100%",
        height: `${height}px`,
        position: "relative",
        userSelect: "none",
        overflow: "hidden",
        backgroundColor: BAR_BG,
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          width: "100%",
          height: `${height}px`,
          display: "block",
          cursor: isDragging ? "grabbing" : "grab",
        }}
        aria-label="Audio waveform timeline"
        role="img"
      />
    </div>
  );
}
