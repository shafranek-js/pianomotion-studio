import packageInfo from "../../package.json";
import { applicationBuildId } from "../pwa/urls";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type DiagnosticLevel = "info" | "warning" | "error";
export interface DiagnosticEvent {
  sessionId: string;
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  level: DiagnosticLevel;
  event: string;
  details: JsonValue;
}

const STORAGE_KEY = "pianomotion.diagnostics.v1";
const MAX_EVENTS = 2_000;
const MAX_CHARACTERS = 500_000;
const OMITTED_FIELDS = /^(?:midiBytes|rawMidiBytes|sampleData|audioData|document|poses|fingeringPlan|performancePlan|buffer|blob)$/i;

function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): JsonValue {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value).slice(0, 100);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (typeof Blob !== "undefined" && value instanceof Blob)) return "[binary omitted]";
  if (seen.has(value)) return "[circular]";
  if (depth >= 5) return "[depth limit]";
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: value.message.slice(0, 2_000), stack: value.stack?.slice(0, 4_000) ?? null };
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 40).filter(([key]) => !OMITTED_FIELDS.test(key))
    .map(([key, item]) => [key, sanitize(item, depth + 1, seen)]));
}

/** Bounded structured history. Logging failures never propagate into musical operations. */
export class DiagnosticJournal {
  private entries: { event: DiagnosticEvent; length: number }[] = [];
  private characters = 0;
  private sequence = 0;
  private readonly startedAt: number;
  public constructor(
    public readonly sessionId: string = crypto.randomUUID(),
    private readonly now = () => Date.now(),
    private readonly maxEvents = MAX_EVENTS,
    private readonly maxCharacters = MAX_CHARACTERS,
  ) { this.startedAt = now(); }

  public record(event: string, details: unknown = {}, level: DiagnosticLevel = "info"): void {
    try {
      const timestamp = this.now();
      this.append({ sessionId: this.sessionId, sequence: ++this.sequence, timestamp: new Date(timestamp).toISOString(),
        elapsedMs: Math.max(0, timestamp - this.startedAt), level, event: event.slice(0, 120), details: sanitize(details) });
    } catch { /* Observability must not break playback, even for hostile error objects. */ }
  }

  public restore(serialized: string | null): void {
    if (!serialized || serialized.length > this.maxCharacters + 20_000) return;
    try {
      const history: unknown = JSON.parse(serialized);
      if (!Array.isArray(history)) return;
      for (const entry of history.slice(-this.maxEvents)) {
        if (typeof entry?.sessionId !== "string" || typeof entry?.event !== "string" ||
            typeof entry?.timestamp !== "string" || !Number.isSafeInteger(entry?.sequence) ||
            !Number.isFinite(entry?.elapsedMs) || !["info", "warning", "error"].includes(entry?.level)) continue;
        this.append({ sessionId: entry.sessionId.slice(0, 120), sequence: entry.sequence,
          timestamp: entry.timestamp.slice(0, 64), elapsedMs: entry.elapsedMs, level: entry.level,
          event: entry.event.slice(0, 120), details: sanitize(entry.details) });
      }
    } catch { /* An invalid diagnostic history is unrelated to project persistence. */ }
  }

  public snapshot(): DiagnosticEvent[] { return this.entries.map(({ event }) => structuredClone(event)); }
  public serialize(): string { return JSON.stringify(this.entries.map(({ event }) => event)); }
  public clear(): void { this.entries = []; this.characters = 0; }

  private append(event: DiagnosticEvent): void {
    const length = JSON.stringify(event).length + 1;
    if (length > this.maxCharacters - 2) return;
    this.entries.push({ event, length });
    this.characters += length;
    while (this.entries.length > this.maxEvents || this.characters + 2 > this.maxCharacters) {
      this.characters -= this.entries.shift()!.length;
    }
  }
}

export const diagnosticJournal = new DiagnosticJournal();
let initialized = false;
let storage: Storage | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let lifetime: AbortController | undefined;

export function flushDiagnosticLog(): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  try { storage?.setItem(STORAGE_KEY, diagnosticJournal.serialize()); }
  catch { /* Keep the in-memory history if persistence is unavailable or full. */ }
}

export function recordDiagnostic(event: string, details: unknown = {}, level: DiagnosticLevel = "info"): void {
  diagnosticJournal.record(event, details, level);
  if (storage && flushTimer === undefined) flushTimer = setTimeout(flushDiagnosticLog, 1_000);
  if (level === "error") flushDiagnosticLog();
}

export function initializeDiagnosticLog(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  try { storage = window.localStorage; diagnosticJournal.restore(storage.getItem(STORAGE_KEY)); }
  catch { /* Private mode may deny persistence; memory logging still works. */ }
  recordDiagnostic("session.started", { appVersion: packageInfo.version, buildId: applicationBuildId(),
    userAgent: navigator.userAgent, path: location.pathname, online: navigator.onLine });
  window.addEventListener("error", (event: Event) => {
    if (event instanceof ErrorEvent) recordDiagnostic("browser.error", { message: event.message, filename: event.filename,
      line: event.lineno, column: event.colno, error: event.error }, "error");
    else if (event.target instanceof HTMLElement) recordDiagnostic("resource.error", {
      tag: event.target.tagName, url: event.target.getAttribute("src") ?? event.target.getAttribute("href") }, "error");
  }, { ...options, capture: true });
  window.addEventListener("unhandledrejection", event => recordDiagnostic("browser.unhandled-rejection", { error: event.reason }, "error"), options);
  window.addEventListener("online", () => recordDiagnostic("network.online"), options);
  window.addEventListener("offline", () => recordDiagnostic("network.offline", {}, "warning"), options);
  document.addEventListener("visibilitychange", () => {
    recordDiagnostic("page.visibility", { visibility: document.visibilityState });
    if (document.visibilityState === "hidden") flushDiagnosticLog();
  }, options);
  window.addEventListener("pagehide", flushDiagnosticLog, options);
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  flushDiagnosticLog();
  lifetime?.abort();
  initialized = false;
  storage = undefined;
});

export function diagnosticLogContents(): string {
  flushDiagnosticLog();
  return JSON.stringify({ schemaVersion: 1, appVersion: packageInfo.version, buildId: applicationBuildId(),
    exportedAt: new Date().toISOString(), currentSessionId: diagnosticJournal.sessionId,
    limits: { maxEvents: MAX_EVENTS, maxCharacters: MAX_CHARACTERS }, events: diagnosticJournal.snapshot() }, null, 2);
}

export function downloadDiagnosticLog(): void {
  recordDiagnostic("diagnostics.exported");
  const url = URL.createObjectURL(new Blob([diagnosticLogContents()], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `pianomotion-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function clearDiagnosticLog(): void {
  diagnosticJournal.clear();
  recordDiagnostic("diagnostics.cleared");
  flushDiagnosticLog();
}
