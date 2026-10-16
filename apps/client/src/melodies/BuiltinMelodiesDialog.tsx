import { useEffect, useId, useMemo, useState } from "react";
import { Music2, RotateCw, Search, X } from "lucide-react";
import { StudioDialog } from "../studio/StudioDialog";
import { loadBuiltinMelodies, type BuiltinMelodyEntry } from "./catalog";
import styles from "./BuiltinMelodiesDialog.module.css";

type CatalogResult =
  | { attempt: number; state: "ready"; entries: BuiltinMelodyEntry[] }
  | { attempt: number; state: "error"; message: string };

const EMPTY_ENTRIES: BuiltinMelodyEntry[] = [];

export interface BuiltinMelodiesDialogProps {
  open: boolean;
  onClose(): void;
  onChoose(entry: BuiltinMelodyEntry): void;
  busy?: boolean;
}

export function BuiltinMelodiesDialog({ open, onClose, onChoose, busy = false }: BuiltinMelodiesDialogProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [catalogResult, setCatalogResult] = useState<CatalogResult | null>(null);

  useEffect(() => {
    if (!open || catalogResult?.attempt === loadAttempt) return;

    const controller = new AbortController();

    void loadBuiltinMelodies(controller.signal).then((catalog) => {
      if (controller.signal.aborted) return;
      setCatalogResult({ attempt: loadAttempt, state: "ready", entries: catalog });
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setCatalogResult({
        attempt: loadAttempt,
        state: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    });

    return () => controller.abort();
  }, [open, loadAttempt, catalogResult]);

  const currentResult = catalogResult?.attempt === loadAttempt ? catalogResult : null;
  const catalogState = currentResult?.state ?? "loading";
  const entries = currentResult?.state === "ready" ? currentResult.entries : EMPTY_ENTRIES;
  const loadError = currentResult?.state === "error" ? currentResult.message : "";

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? entries.filter((entry) => entry.title.toLocaleLowerCase().includes(needle))
      : entries;
  }, [entries, query]);

  if (!open) return null;

  return (
    <StudioDialog
      screen
      title="Built-in melodies"
      description="Choose a built-in MIDI melody to open as a project."
      onClose={onClose}
    >
      <div className={styles.dialog}>
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            <span className={styles.titleIcon} aria-hidden="true"><Music2 size={20} /></span>
            <h1>Built-in melodies</h1>
          </div>
          <button className={styles.close} type="button" onClick={onClose} aria-label="Close built-in melodies">
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.controls}>
          <label className={styles.searchLabel} htmlFor={searchId}>Search melodies</label>
          <div className={styles.searchBox}>
            <Search className={styles.searchIcon} size={17} aria-hidden="true" />
            <input
              id={searchId}
              className={styles.search}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search by title"
              autoComplete="off"
            />
          </div>
          {catalogState === "ready" && (
            <p className={styles.count} role="status" aria-live="polite" aria-atomic="true">
              {query.trim() ? `${filteredEntries.length} of ${entries.length} melodies` : `${entries.length} melodies`}
            </p>
          )}
        </div>

        <div className={styles.results}>
          {catalogState === "loading" && (
            <p className={styles.message} role="status" aria-live="polite">Loading built-in melodies…</p>
          )}
          {catalogState === "error" && (
            <div className={styles.error} role="alert">
              <p>{loadError}</p>
              <button className={styles.retry} type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                <RotateCw size={16} aria-hidden="true" /> Retry
              </button>
            </div>
          )}
          {catalogState === "ready" && filteredEntries.length === 0 && (
            <p className={styles.message} role="status">
              {query.trim() ? `No melodies match “${query.trim()}”.` : "No built-in melodies are available."}
            </p>
          )}
          {catalogState === "ready" && filteredEntries.length > 0 && (
            <ul className={styles.list} aria-label="Built-in melodies">
              {filteredEntries.map((entry) => (
                <li className={styles.row} key={entry.id}>
                  <button
                    className={styles.choice}
                    type="button"
                    aria-label={`Open ${entry.title}`}
                    disabled={busy}
                    onClick={() => onChoose(entry)}
                  >
                    <span className={styles.choiceIcon} aria-hidden="true"><Music2 size={18} /></span>
                    <span className={styles.copy}>
                      <span className={styles.name}>{entry.title}</span>
                      <span className={styles.meta}>{entry.fileName}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {busy && <p className={styles.opening} role="status" aria-live="polite">Opening melody…</p>}
        </div>
      </div>
    </StudioDialog>
  );
}
