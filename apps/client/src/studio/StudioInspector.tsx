import type { ReactNode, ChangeEvent } from "react";
import type { M1AnalyzeMidiResult, M1KeyStyle } from "@handthesia/contracts";
import type { PianistProfile } from "../profiles";
import type { AppSettings, CalculationEngine, SkinStyleSetting } from "../settings";
import { normalizeStageAppearance, type StageAppearance, type StagePreset, type StageQuality } from "../settings/stageAppearance";
import { useI18n } from "../i18n";
import type { DecodedAudioRecording } from "../audio/recording/audioDecoder";
import type { PlanDiagnostic } from "@handthesia/contracts";
import type { DifficultyReport } from "../editor/types";
import { DiagnosticsPanel } from "../editor/DiagnosticsPanel";
import type { InspectorTab } from "./types";
import styles from "./StudioInspector.module.css";
import { DiagnosticLogControls } from "../diagnostics/DiagnosticLogControls";
import { formatDisplaySourceName } from "../melodies/catalog";

export interface StudioInspectorProps {
  tab: InspectorTab;
  result: M1AnalyzeMidiResult | null;
  profile: PianistProfile;
  settings: AppSettings;
  keyStyle: M1KeyStyle;
  audioRecording: DecodedAudioRecording | null;
  audioOffset: number;
  audioOutputLabel?: string;
  sourceName: string;
  busy: boolean;
  developerTools?: ReactNode;
  difficultyReport?: DifficultyReport;
  planDiagnostics?: PlanDiagnostic[];
  calculationError?: string;
  activeCalculationEngine?: CalculationEngine;
  canRetryCalculation?: boolean;
  onRetryCalculation?(): void;
  onSelectNote?(noteId: string): void;
  onKeyStyleChange(style: M1KeyStyle): void;
  onSkinStyleChange(style: SkinStyleSetting): void;
  onStageAppearanceChange?(value: StageAppearance): void;
  onCalculationEngineChange?(engine: CalculationEngine): void;
  onOpenPianist(): void;
  onAudioFileChange(event: ChangeEvent<HTMLInputElement>): void;
  onClearAudio(): void;
  onAudioOffsetChange(offset: number): void;
}

export function StudioInspector(props: StudioInspectorProps) {
  const { tab, result, profile, settings, keyStyle, audioRecording, audioOffset, sourceName, busy } = props;
  const { t, dict } = useI18n();
  const stageAppearance = normalizeStageAppearance(settings.stageAppearance);

  if (tab === "scene") return (
    <section className={styles.content} aria-label={dict.inspector.sceneSettings}>
      <h2 className={styles.heading}>{dict.inspector.sceneTitle}</h2>
      <div className={styles.stageAppearance}>
        <h3 className={styles.subheading}>{t("stageAppearance.title")}</h3>
        <label className={styles.field} htmlFor="studio-stage-preset">
          <span>{t("stageAppearance.preset")}</span>
          <select
            id="studio-stage-preset"
            value={stageAppearance.preset}
            disabled={!props.onStageAppearanceChange}
            onChange={(event) => props.onStageAppearanceChange?.({
              ...stageAppearance,
              preset: event.currentTarget.value as StagePreset,
            })}
          >
            <option value="concert">{t("stageAppearance.concert")}</option>
            <option value="studio">{t("stageAppearance.studio")}</option>
          </select>
        </label>
        <label className={styles.field} htmlFor="studio-stage-brightness">
          <span className={styles.rangeHeading}>
            <span>{t("stageAppearance.brightness")}</span>
            <output aria-hidden="true">{formatPercent(stageAppearance.brightness)}</output>
          </span>
          <input
            id="studio-stage-brightness"
            className={styles.rangeInput}
            type="range"
            min={0.5}
            max={1.5}
            step={0.05}
            value={stageAppearance.brightness}
            aria-valuetext={formatPercent(stageAppearance.brightness)}
            disabled={!props.onStageAppearanceChange}
            onChange={(event) => props.onStageAppearanceChange?.({
              ...stageAppearance,
              brightness: event.currentTarget.valueAsNumber,
            })}
          />
        </label>
        <label className={styles.field} htmlFor="studio-stage-reflection">
          <span className={styles.rangeHeading}>
            <span>{t("stageAppearance.reflectionStrength")}</span>
            <output aria-hidden="true">{formatPercent(stageAppearance.reflection)}</output>
          </span>
          <input
            id="studio-stage-reflection"
            className={styles.rangeInput}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={stageAppearance.reflection}
            aria-valuetext={formatPercent(stageAppearance.reflection)}
            disabled={!props.onStageAppearanceChange}
            onChange={(event) => props.onStageAppearanceChange?.({
              ...stageAppearance,
              reflection: event.currentTarget.valueAsNumber,
            })}
          />
        </label>
        <label className={styles.field} htmlFor="studio-stage-quality">
          <span>{t("stageAppearance.quality")}</span>
          <select
            id="studio-stage-quality"
            value={stageAppearance.quality}
            disabled={!props.onStageAppearanceChange}
            onChange={(event) => props.onStageAppearanceChange?.({
              ...stageAppearance,
              quality: event.currentTarget.value as StageQuality,
            })}
          >
            <option value="auto">{t("stageAppearance.qualityAuto")}</option>
            <option value="low">{t("stageAppearance.qualityLow")}</option>
            <option value="high">{t("stageAppearance.qualityHigh")}</option>
          </select>
        </label>
        <p className={styles.hint}>{t("stageAppearance.storageHint")}</p>
      </div>
      <label className={styles.field} htmlFor="studio-key-style">
        <span>{dict.inspector.keyboardGeometry}</span>
        <select id="studio-key-style" value={keyStyle} disabled={busy} onChange={(event) => props.onKeyStyleChange(event.currentTarget.value as M1KeyStyle)}>
          <option value="realistic">{dict.inspector.realisticWidths}</option>
          <option value="equal">{dict.inspector.equalWidths}</option>
        </select>
      </label>
      <label className={styles.field} htmlFor="studio-skin-style">
        <span>{dict.inspector.handStyle}</span>
        <select id="studio-skin-style" value={settings.skinStyle} onChange={(event) => props.onSkinStyleChange(event.currentTarget.value as SkinStyleSetting)}>
          <option value="realistic">{dict.inspector.realistic}</option>
          <option value="cartoon">{dict.inspector.cartoon}</option>
          <option value="gloves">{dict.inspector.gloves}</option>
          <option value="robot">{dict.inspector.robot}</option>
          <option value="skeleton">{dict.inspector.skeleton}</option>
        </select>
      </label>
      <p className={styles.hint}>{dict.inspector.sceneHint}</p>
    </section>
  );

  if (tab === "pianist") return (
    <section className={styles.content} aria-label={dict.inspector.pianistProfile}>
      <h2 className={styles.heading}>{dict.inspector.pianistTitle}</h2>
      <div className={styles.profileCard}>
        <span className={styles.profileColor} style={{ backgroundColor: `rgb(${profile.colorRgb.join(",")})` }} aria-hidden="true" />
        <div className={styles.profileCopy}>
          <strong>{profile.name}</strong>
          <span>{profile.profileId} · {dict.inspector.revision} {profile.revision}</span>
        </div>
      </div>
      {props.onCalculationEngineChange && (
        <label className={styles.field} htmlFor="studio-pianist-calculation-engine">
          <span>{dict.inspector.calculationEngine}</span>
          <select
            id="studio-pianist-calculation-engine"
            value={settings.calculationEngine}
            disabled={busy}
            onChange={(event) => props.onCalculationEngineChange?.(event.currentTarget.value as CalculationEngine)}
          >
            <option value="typescript">{dict.inspector.typescriptNativeDefault}</option>
            <option value="python">{dict.inspector.pythonPyodide}</option>
          </select>
        </label>
      )}
      <p className={styles.hint}>{dict.inspector.pianistHint}</p>
      <button className={styles.primaryButton} type="button" onClick={props.onOpenPianist}>{dict.inspector.editPianist}</button>
    </section>
  );

  if (tab === "audio") return (
    <section className={styles.content} aria-label={dict.inspector.audioSettings}>
      <h2 className={styles.heading}>{dict.inspector.audioTitle}</h2>
      {props.audioOutputLabel && <p role="status" className={styles.hint}>{props.audioOutputLabel}</p>}
      <label id="audio-track-upload-label" className={styles.upload}>
        <span>{audioRecording ? dict.inspector.replaceRecording : dict.inspector.importRecording}</span>
        <span className={styles.hint}>{dict.inspector.audioFormats}</span>
        <input id="audio-track-file-input" type="file" accept=".wav,.mp3,.ogg,.flac,audio/*" onChange={props.onAudioFileChange} />
      </label>
      {audioRecording ? (
        <>
          <div className={styles.audioSummary}>
            <strong>{audioRecording.filename || dict.inspector.audioRecording}</strong>
            <span>{formatTime(audioRecording.durationSeconds)} · {audioRecording.sampleRate.toLocaleString()} Hz</span>
            <span className={styles.hint}>{dict.inspector.audioSessionOnly}</span>
          </div>
          <label className={styles.field} htmlFor="studio-audio-offset">
            <span>{dict.inspector.audioOffset}</span>
            <input
              id="studio-audio-offset"
              type="number"
              min={-30}
              max={30}
              step={0.01}
              value={audioOffset}
              onChange={(event) => props.onAudioOffsetChange(Number(event.currentTarget.value))}
            />
          </label>
          <button id="audio-track-clear-btn" className={styles.secondaryButton} type="button" onClick={props.onClearAudio}>{dict.inspector.removeRecording}</button>
        </>
      ) : <p className={styles.hint}>{dict.inspector.audioHint}</p>}
    </section>
  );

  return (
    <section className={styles.content} aria-label={dict.inspector.diagnosticsTitle}>
      <h2 className={styles.heading}>{dict.inspector.diagnosticsTitle}</h2>
      {props.onCalculationEngineChange && (
        <label className={styles.field} htmlFor="studio-calculation-engine">
          <span>{dict.inspector.calculationEngine}</span>
          <select
            id="studio-calculation-engine"
            value={settings.calculationEngine}
            disabled={busy}
            onChange={(event) => props.onCalculationEngineChange?.(event.currentTarget.value as CalculationEngine)}
          >
            <option value="typescript">{dict.inspector.typescriptNativeDefault}</option>
            <option value="python">{dict.inspector.pythonPyodide}</option>
          </select>
        </label>
      )}
      <dl className={styles.metrics}>
        <div>
          <dt>{dict.inspector.source}</dt>
          <dd title={result?.rawBaseline?.fixtureId ? `${sourceName || dict.inspector.noProject} (${result.rawBaseline.fixtureId})` : (sourceName || dict.inspector.noProject)}>
            {formatDisplaySourceName(sourceName, result?.rawBaseline?.fixtureId)}
          </dd>
        </div>
        <div><dt>{dict.inspector.notes}</dt><dd>{result?.document?.notes.length.toLocaleString() ?? "—"}</dd></div>
        <div><dt>{dict.inspector.tracks}</dt><dd>{result?.document?.tracks.length.toLocaleString() ?? "—"}</dd></div>
        <div><dt>{dict.inspector.analysisState}</dt><dd>{result?.status ?? dict.inspector.idle}</dd></div>
        <div><dt>{dict.inspector.activeEngine}</dt><dd>{props.activeCalculationEngine
          ? props.activeCalculationEngine === "typescript" ? dict.inspector.typescriptNative : dict.inspector.pythonPyodide
          : dict.inspector.noComputedProject}</dd></div>
        {props.activeCalculationEngine && props.activeCalculationEngine !== settings.calculationEngine &&
          <div><dt>{dict.inspector.requestedEngine}</dt><dd>{settings.calculationEngine === "typescript" ? dict.inspector.typescriptNative : dict.inspector.pythonPyodide}</dd></div>}
      </dl>
      {props.calculationError && <div role="alert" className={styles.diagnostics}>
        <strong>{dict.inspector.calculationError}</strong>
        <pre>{props.calculationError}</pre>
        {props.canRetryCalculation && <button className={styles.secondaryButton} type="button" onClick={props.onRetryCalculation}>{dict.inspector.retryCalculation}</button>}
      </div>}
      {result && <ul className={styles.diagnostics}>
        {result.diagnostics.length === 0 ? <li>{dict.inspector.noEngineDiagnostics}</li> : result.diagnostics.map((item, index) => (
          <li key={`${item.code}-${index}`} data-severity={item.severity}>
            <strong>{item.code}</strong><span>{item.message}</span>
          </li>
        ))}
      </ul>}
      {props.difficultyReport && <DiagnosticsPanel
        difficulty={props.difficultyReport}
        diagnostics={props.planDiagnostics ?? []}
        onSelectNote={props.onSelectNote}
      />}
      <DiagnosticLogControls />
      <details className={styles.developer}>
        <summary>{dict.inspector.developerTools}</summary>
        <div className={styles.developerContent}>{props.developerTools}</div>
      </details>
    </section>
  );
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
