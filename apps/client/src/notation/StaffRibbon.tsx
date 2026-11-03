import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import {
  serializeStaffMusicXml,
  type StaffNotationModel,
} from "./staffNotationBuilder";
import styles from "./StaffRibbon.module.css";

export interface StaffRibbonProps {
  readonly model: StaffNotationModel;
  readonly showFingers: boolean;
  readonly showNoteNames: boolean;
  readonly currentTime: number;
  readonly getLiveTime?: () => number;
  readonly onSeek: (timeSeconds: number) => void;
}

const SINGLE_LINE_SHEET_MAX_WIDTH = 1_000_000;
const MIN_RIBBON_HEIGHT_PX = 120;
const MAX_RIBBON_HEIGHT_PX = 320;
const VERTICAL_PADDING_PX = 12;

/**
 * Measures the actual rendered OSMD SVG height for the current melody (including
 * its high/low ledger lines, stems, and fingerings), ported from MelodicaTrainer's `getOsmdRenderedHeight`.
 */
function getOsmdRenderedHeight(container: HTMLElement): number {
  const renderedHeight = Math.max(
    0,
    ...Array.from(container.querySelectorAll("svg"))
      .filter((svg) => svg.childElementCount > 0)
      .map((svg) => svg.getBoundingClientRect().height),
  );
  if (renderedHeight <= 0) return 164;
  return Math.max(
    MIN_RIBBON_HEIGHT_PX,
    Math.min(MAX_RIBBON_HEIGHT_PX, Math.ceil(renderedHeight + VERTICAL_PADDING_PX)),
  );
}

interface CursorAnchor {
  readonly timeSeconds: number;
  readonly xPx: number;
}

function interpolatePlayheadX(anchors: readonly CursorAnchor[], timeSeconds: number): number {
  if (anchors.length === 0) return 0;
  if (timeSeconds <= anchors[0].timeSeconds) return anchors[0].xPx;
  const last = anchors[anchors.length - 1];
  if (timeSeconds >= last.timeSeconds) return last.xPx;

  let lo = 0;
  let hi = anchors.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].timeSeconds <= timeSeconds) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const a0 = anchors[lo];
  const a1 = anchors[hi];
  const dt = a1.timeSeconds - a0.timeSeconds;
  if (dt <= 1e-6) return a0.xPx;
  const frac = Math.max(0, Math.min(1, (timeSeconds - a0.timeSeconds) / dt));
  return a0.xPx + frac * (a1.xPx - a0.xPx);
}

function interpolateSeekTime(anchors: readonly CursorAnchor[], clickXPx: number): number {
  if (anchors.length === 0) return 0;
  if (clickXPx <= anchors[0].xPx) return anchors[0].timeSeconds;
  const last = anchors[anchors.length - 1];
  if (clickXPx >= last.xPx) return last.timeSeconds;

  let lo = 0;
  let hi = anchors.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].xPx <= clickXPx) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const a0 = anchors[lo];
  const a1 = anchors[hi];
  const dx = a1.xPx - a0.xPx;
  if (dx <= 1e-6) return a0.timeSeconds;
  const frac = Math.max(0, Math.min(1, (clickXPx - a0.xPx) / dx));
  return a0.timeSeconds + frac * (a1.timeSeconds - a0.timeSeconds);
}

export function StaffRibbon({
  model,
  showFingers,
  showNoteNames,
  currentTime,
  getLiveTime,
  onSeek,
}: StaffRibbonProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const osmdHostRef = useRef<HTMLDivElement | null>(null);
  const osmdInstanceRef = useRef<OpenSheetMusicDisplay | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const anchorsRef = useRef<CursorAnchor[]>([]);
  const lastPlayheadXRef = useRef<number | null>(null);
  const renderGenerationRef = useRef(0);

  const [ribbonHeightPx, setRibbonHeightPx] = useState<number>(156);

  const musicXml = useMemo(
    () =>
      model.measures.length > 0
        ? serializeStaffMusicXml(model, {
            showFingers,
            showNoteNames,
          })
        : "",
    [model, showFingers, showNoteNames],
  );

  // Mount & render OpenSheetMusicDisplay in single horizontal staffline mode (ported from MelodicaTrainer useOsmdScore.ts)
  useEffect(() => {
    const container = osmdHostRef.current;
    if (!container || !musicXml) {
      osmdInstanceRef.current?.clear();
      osmdInstanceRef.current = null;
      anchorsRef.current = [];
      return;
    }

    const generation = ++renderGenerationRef.current;
    osmdInstanceRef.current?.clear();
    container.replaceChildren();

    const osmd = new OpenSheetMusicDisplay(container, {
      backend: "svg",
      drawingParameters: "compacttight",
      drawCredits: false,
      drawTitle: false,
      drawSubtitle: false,
      drawComposer: false,
      drawLyricist: false,
      drawMetronomeMarks: false,
      drawPartNames: false,
      drawPartAbbreviations: false,
      drawMeasureNumbers: true,
      drawLyrics: false,
      drawFingerings: showFingers || showNoteNames,
      fingeringPosition: "aboveorbelow",
      autoResize: false,
      followCursor: false,
      renderSingleHorizontalStaffline: true,
    });

    const zoom = 0.68;
    osmd.EngravingRules.SheetMaximumWidth = SINGLE_LINE_SHEET_MAX_WIDTH;
    osmd.EngravingRules.PageTopMargin = 1.8;
    osmd.EngravingRules.PageBottomMargin = 1.8;
    osmd.EngravingRules.StaffLineWidth = 0.1;
    osmd.EngravingRules.StaffLineColor = "#9ca3af";
    osmd.EngravingRules.LedgerLineWidth = 0.1;
    osmd.EngravingRules.LedgerLineColorDefault = "#9ca3af";
    osmd.EngravingRules.SystemThinLineWidth = 0.1;
    osmd.Zoom = zoom;
    osmdInstanceRef.current = osmd;

    void osmd
      .load(musicXml)
      .then(() => {
        if (renderGenerationRef.current !== generation) return;
        osmd.render();
        Array.from(container.querySelectorAll("svg")).forEach((svg) => {
          if (svg.childElementCount === 0) svg.remove();
        });

        const adaptiveHeight = getOsmdRenderedHeight(container);
        setRibbonHeightPx(adaptiveHeight);

        // Build exact timeSeconds <-> pixel X anchors from OSMD's rendered cursor positions
        const anchors: CursorAnchor[] = [];
        const quarterSeconds = 60 / Math.max(20, model.bpm || 120);
        const cursor = osmd.cursor;
        if (cursor) {
          cursor.show();
          cursor.reset();
          let safety = 0;
          while (!cursor.Iterator.EndReached && safety < 20_000) {
            safety += 1;
            const realVal = cursor.Iterator.CurrentSourceTimestamp?.RealValue ?? 0;
            const timeSec = realVal * 4 * quarterSeconds;
            const leftPx = Number.parseFloat(cursor.cursorElement?.style?.left || "0");
            if (
              Number.isFinite(leftPx) &&
              (anchors.length === 0 ||
                timeSec > anchors[anchors.length - 1].timeSeconds + 1e-4)
            ) {
              anchors.push({ timeSeconds: timeSec, xPx: leftPx });
            }
            cursor.next();
          }
          cursor.hide();
        }

        const svgEl = container.querySelector("svg");
        const svgWidth = svgEl ? svgEl.getBoundingClientRect().width : 0;
        if (
          svgWidth > 0 &&
          (anchors.length === 0 ||
            model.durationSeconds > anchors[anchors.length - 1].timeSeconds + 0.01)
        ) {
          const maxLeft = Math.max(
            anchors.length > 0 ? anchors[anchors.length - 1].xPx + 24 : 48,
            svgWidth - 20,
          );
          anchors.push({
            timeSeconds: model.durationSeconds,
            xPx: maxLeft,
          });
        }
        anchorsRef.current = anchors;
        lastPlayheadXRef.current = null;
      })
      .catch(() => {
        // Ignore transient OSMD load cancellation
      });
  }, [model.bpm, model.durationSeconds, musicXml, showFingers, showNoteNames]);

  // 60-120fps continuous GPU-composited playhead interpolation & auto-scroll
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const liveTime = Math.max(0, getLiveTime ? getLiveTime() : currentTime);
      const x = interpolatePlayheadX(anchorsRef.current, liveTime);
      if (playheadRef.current) {
        playheadRef.current.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
      }
      const prevX = lastPlayheadXRef.current;
      const moved = prevX === null || Math.abs(x - prevX) > 0.02;
      lastPlayheadXRef.current = x;

      const container = scrollRef.current;
      if (container && moved && anchorsRef.current.length > 0) {
        const width = container.clientWidth || 800;
        const targetScroll = Math.max(0, x + 16 - width * 0.35);
        container.scrollLeft = targetScroll;
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [currentTime, getLiveTime]);

  const handleStageClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const host = osmdHostRef.current;
      if (!host || anchorsRef.current.length === 0) return;
      const rect = host.getBoundingClientRect();
      const clickX = Math.max(0, event.clientX - rect.left);
      const targetSeconds = interpolateSeekTime(anchorsRef.current, clickX);
      onSeek(Math.max(0, Math.min(model.durationSeconds, targetSeconds)));
    },
    [model.durationSeconds, onSeek],
  );

  if (model.measures.length === 0) return null;

  return (
    <div
      className={styles.ribbon}
      style={{ height: `${ribbonHeightPx}px`, minHeight: `${ribbonHeightPx}px` }}
      data-testid="staff-ribbon"
      role="region"
      aria-label="Grand staff notation ribbon"
    >
      <div
        ref={scrollRef}
        className={styles.scrollTrack}
        data-testid="staff-ribbon-scroll"
      >
        <div className={styles.sheetStage} onClick={handleStageClick}>
          <div ref={osmdHostRef} className={styles.osmdDark} />
          <div ref={playheadRef} className={styles.playhead} />
        </div>
      </div>
    </div>
  );
}
