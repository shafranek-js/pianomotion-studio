import { useEffect, useMemo, useRef, useState } from "react";
import type { PieceHarmonyAnalysis } from "./harmonyAnalyzer";
import styles from "./ChordRibbon.module.css";

export interface ChordRibbonProps {
  harmony: PieceHarmonyAnalysis;
  currentTime: number;
  onSeek(timeSeconds: number): void;
}

export function ChordRibbon({ harmony, currentTime, onSeek }: ChordRibbonProps) {
  const [smoothVoicing, setSmoothVoicing] = useState(true);
  const trackRef = useRef<HTMLDivElement>(null);
  const activeCellRef = useRef<HTMLButtonElement | null>(null);

  const activeChord = useMemo(() => {
    if (harmony.chords.length === 0) return null;
    for (let i = harmony.chords.length - 1; i >= 0; i -= 1) {
      const c = harmony.chords[i];
      if (currentTime >= c.startSeconds - 0.02) {
        return c;
      }
    }
    return harmony.chords[0];
  }, [harmony.chords, currentTime]);

  useEffect(() => {
    const cell = activeCellRef.current;
    const container = trackRef.current;
    if (!cell || !container) return;
    const cellLeft = cell.offsetLeft;
    const cellRight = cellLeft + cell.offsetWidth;
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    if (cellLeft < viewLeft || cellRight > viewRight) {
      container.scrollTo({
        left: Math.max(0, cellLeft - container.clientWidth * 0.25),
        behavior: "smooth",
      });
    }
  }, [activeChord?.index]);

  if (harmony.chords.length === 0) return null;

  const displayedSymbol = activeChord
    ? smoothVoicing
      ? activeChord.slashSymbol
      : activeChord.symbol
    : "N.C.";
  const displayedTones = activeChord
    ? (smoothVoicing ? activeChord.smoothToneNames : activeChord.toneNames).join("–")
    : "";

  return (
    <div className={styles.ribbon} data-testid="chord-ribbon" role="region" aria-label="Chord timeline">
      <div className={styles.metaGroup}>
        {harmony.key && (
          <span className={styles.keyBadge} data-testid="chord-ribbon-key">
            Key: {harmony.key.tonic} {harmony.key.mode}
          </span>
        )}
        <button
          type="button"
          className={`${styles.smoothToggle} ${smoothVoicing ? styles.smoothToggleActive : ""}`}
          aria-pressed={smoothVoicing}
          onClick={() => setSmoothVoicing((v) => !v)}
          title="Voice chords in the nearest inversion so your hand barely moves"
        >
          Smooth voicing
        </button>
        {activeChord && activeChord.symbol !== "N.C." && (
          <span className={styles.activeReadout} data-testid="chord-ribbon-active">
            <span className={styles.activeSymbol}>{displayedSymbol}</span>
            {activeChord.numeral && <span className={styles.activeNumeral}>({activeChord.numeral})</span>}
            {displayedTones && <span className={styles.activeTones}>[{displayedTones}]</span>}
          </span>
        )}
      </div>

      <div ref={trackRef} className={styles.track}>
        {harmony.chords.map((chord) => {
          const isActive = activeChord?.index === chord.index;
          const labelSymbol = smoothVoicing ? chord.slashSymbol : chord.symbol;
          return (
            <button
              key={chord.index}
              ref={isActive ? activeCellRef : null}
              type="button"
              className={`${styles.cell} ${isActive ? styles.cellActive : ""}`}
              aria-current={isActive ? "step" : undefined}
              onClick={() => onSeek(chord.startSeconds)}
              title={`Bar ${chord.bar}: ${labelSymbol}${chord.numeral ? ` (${chord.numeral})` : ""}`}
            >
              <span className={styles.cellBar}>m.{chord.bar}</span>
              <span className={styles.cellSymbol}>{labelSymbol}</span>
              {chord.numeral && <span className={styles.cellNumeral}>{chord.numeral}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
