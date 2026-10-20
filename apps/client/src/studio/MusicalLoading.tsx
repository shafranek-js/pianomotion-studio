import { useEffect, useState } from "react";
import type { AppLanguage } from "../settings/types";
import { loadingStageLabel, measuredProgress, virtualPianistLines, type LoadingExperienceState } from "./loadingExperience";
import "./MusicalLoading.css";

interface MusicalLoadingProps {
  loading: LoadingExperienceState;
  language: AppLanguage;
  /** Full work-area cover during initial startup; compact and nonmodal for background operations. */
  prominent: boolean;
}

function PianistLine({ phase }: { phase: LoadingExperienceState["phase"] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setIndex((current) => (current + 1) % virtualPianistLines[phase].length), 5600);
    return () => window.clearInterval(interval);
  }, [phase]);
  // Personality is decoration, not a live-announced technical status.
  return <p className="musical-loading__pianist" aria-hidden="true">“{virtualPianistLines[phase][index]}”</p>;
}

/** Does not own the musical transport, worker, or source data. */
export function MusicalLoading({ loading, language, prominent }: MusicalLoadingProps) {
  const [delayPassed, setDelayPassed] = useState(false);
  useEffect(() => {
    if (prominent) return;
    const timeout = window.setTimeout(() => setDelayPassed(true), 220);
    return () => window.clearTimeout(timeout);
  }, [prominent]);
  if (!prominent && !delayPassed) return null;
  const fraction = measuredProgress(loading.progress);
  const percent = fraction === undefined ? undefined : Math.round(fraction * 100);
  const title = loadingStageLabel(loading.phase, language);
  return (
    <div className={`musical-loading ${prominent ? "musical-loading--prominent" : "musical-loading--compact"}`}
      data-testid="musical-loading" data-phase={loading.phase} data-mode={prominent ? "prominent" : "compact"}>
      <section className="musical-loading__panel" aria-label={title}>
        <div className="musical-loading__brand"><span className="musical-loading__brand-note" aria-hidden="true">♫</span> PianoMotion Studio</div>
        <div className="musical-loading__score" aria-hidden="true">
          <svg viewBox="0 0 340 112" xmlns="http://www.w3.org/2000/svg" focusable="false">
            {[26, 39, 52, 65, 78].map((y) => <line key={y} x1="8" y1={y} x2="332" y2={y} className="musical-loading__staff" />)}
            {[{x:38,y:65},{x:78,y:52},{x:119,y:59},{x:161,y:39},{x:204,y:52},{x:248,y:45},{x:292,y:65}].map((n,i) => (
              <g key={i} className={fraction === undefined ? "musical-loading__note musical-loading__note--indeterminate" : "musical-loading__note"} style={{ animationDelay: `${i*0.32}s`,
                opacity: fraction === undefined ? undefined : fraction >= (i+1)/7 ? 1 : .24 }}>
                <ellipse cx={n.x} cy={n.y} rx="7.3" ry="4.9" transform={`rotate(-20 ${n.x} ${n.y})`} />
                <path d={`M${n.x+7} ${n.y-1} v-34`} />
              </g>
            ))}
            <line x1="8" y1="97" x2="332" y2="97" className="musical-loading__track"/>
            {fraction !== undefined ? (
              <line x1="8" y1="97" x2={8 + 324 * fraction} y2="97" className="musical-loading__track-progress" />
            ) : (
              <line x1="8" y1="97" x2="88" y2="97" className="musical-loading__track-indeterminate" />
            )}
          </svg>
        </div>
        <div className="musical-loading__factual" role="status" aria-live="polite" aria-atomic="true">
          <h2>{title}</h2>
          {loading.detail && <p>{loading.detail}</p>}
        </div>
        <PianistLine key={loading.phase} phase={loading.phase} />
        <div className="musical-loading__progress" role="progressbar" aria-label={title}
          aria-valuemin={percent === undefined ? undefined : 0}
          aria-valuemax={percent === undefined ? undefined : 100}
          aria-valuenow={percent}>
          <span className={fraction === undefined ? "musical-loading__indeterminate" : ""}
            style={fraction === undefined ? undefined : { width: `${percent}%` }} />
        </div>
        {percent !== undefined && <span className="musical-loading__percent">{percent}%</span>}
      </section>
    </div>
  );
}
