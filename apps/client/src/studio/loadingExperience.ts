import type { AppLanguage } from "../settings/types";

export type LoadingPhase = "startup" | "reading" | "restoring" | "runtime" | "analysis" | "hands" | "fingering" | "motion" | "audio";
export interface LoadingExperienceState {
  /** The active session-operation generation. Stale messages must be ignored by the caller. */
  generation: number;
  phase: LoadingPhase;
  detail: string;
  /** Only measured fractions, scoped to the named operation, may be shown. */
  progress?: number;
}

const factualLabels: Record<AppLanguage, Record<LoadingPhase, string>> = {
  en: { startup: "Starting the studio", reading: "Reading MIDI", restoring: "Restoring your project", runtime: "Preparing the Python engine", analysis: "Analyzing the score", hands: "Separating the hands", fingering: "Planning fingering", motion: "Preparing hand motion", audio: "Preparing audio" },
  cs: { startup: "Spouštění studia", reading: "Načítání MIDI", restoring: "Obnovování projektu", runtime: "Příprava Python enginu", analysis: "Analýza partitury", hands: "Rozdělování rukou", fingering: "Výpočet prstokladu", motion: "Příprava pohybu rukou", audio: "Příprava zvuku" },
  de: { startup: "Studio wird gestartet", reading: "MIDI wird gelesen", restoring: "Projekt wird wiederhergestellt", runtime: "Python-Engine wird vorbereitet", analysis: "Partitur wird analysiert", hands: "Hände werden zugeordnet", fingering: "Fingersatz wird berechnet", motion: "Handbewegung wird vorbereitet", audio: "Audio wird vorbereitet" },
  es: { startup: "Iniciando el estudio", reading: "Leyendo MIDI", restoring: "Restaurando el proyecto", runtime: "Preparando el motor Python", analysis: "Analizando la partitura", hands: "Separando las manos", fingering: "Calculando la digitación", motion: "Preparando el movimiento", audio: "Preparando el audio" },
  it: { startup: "Avvio dello studio", reading: "Lettura del MIDI", restoring: "Ripristino del progetto", runtime: "Preparazione del motore Python", analysis: "Analisi della partitura", hands: "Separazione delle mani", fingering: "Calcolo della diteggiatura", motion: "Preparazione del movimento", audio: "Preparazione dell'audio" },
  uk: { startup: "Запуск студії", reading: "Читання MIDI", restoring: "Відновлення проєкту", runtime: "Підготовка рушія Python", analysis: "Аналіз партитури", hands: "Розподіл між руками", fingering: "Розрахунок аплікатури", motion: "Підготовка руху рук", audio: "Підготовка звуку" },
};

/** Character lines are ALWAYS English, even for non-English UI locales. */
export const virtualPianistLines: Record<LoadingPhase, readonly string[]> = {
  startup: [
    "Warming up my fingers… don't worry, I counted all ten.",
    "Is the piano in tune? Asking for a friend.",
  ],
  reading: [
    "Reading the score… someone was generous with the notes!",
    "Counting notes. This could take a few bars.",
  ],
  restoring: [
    "Finding your place in the score. No pages lost!",
    "Your masterpiece is exactly where you left it.",
  ],
  runtime: [
    "Checking my sheet music and polishing the piano bench.",
    "A little backstage preparation before the first note.",
  ],
  analysis: [
    "Counting the notes. Please don't make me start over!",
    "This piece has more twists than a jazz solo.",
  ],
  hands: [
    "Left hand, meet right hand. Please cooperate.",
    "Two hands, one piano. Negotiations are going well.",
  ],
  fingering: [
    "Five fingers per hand. Let's see what we can do!",
    "Working out those tricky finger crossings.",
  ],
  motion: [
    "Teaching my wrists some new choreography.",
    "Practicing the elegant part of the performance.",
  ],
  audio: [
    "Tuning the imaginary grand piano…",
    "Making sure the keys sound as good as they look.",
  ],
};

export function loadingStageLabel(phase: LoadingPhase, language: AppLanguage): string {
  return factualLabels[language][phase];
}

/** Classify ONLY genuine Worker messages; unknown messages keep the last known stage. */
export function phaseFromWorkerProgress(message: string, previous: LoadingPhase): LoadingPhase {
  const lower = message.toLowerCase();
  if (/pyodide|python runtime|runtime assets|wheel|python.core|python core|package|engine version|source files/.test(lower)) return "runtime";
  if (/finger|fingering|beam search/.test(lower)) return "fingering";
  if (/separat|hand split|left.hand|right.hand|assigning hands/.test(lower)) return "hands";
  if (/motion|kinematic|trajectory|wrist/.test(lower)) return "motion";
  if (/audio|soundfont|synthesiz/.test(lower)) return "audio";
  if (/midi bytes|reading midi|loading midi|parsing midi|decoding midi/.test(lower)) return "reading";
  if (/analy|comput|calculat|note|score|performance/.test(lower)) return "analysis";
  return previous;
}

export function measuredProgress(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}
