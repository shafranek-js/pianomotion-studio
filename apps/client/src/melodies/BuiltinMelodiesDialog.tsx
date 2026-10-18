import { useEffect, useId, useMemo, useState } from "react";
import { ArrowUpDown, Music2, RotateCw, Search, Star, X } from "lucide-react";
import { StudioDialog } from "../studio/StudioDialog";
import { loadBuiltinMelodies, type BuiltinMelodyEntry, type BuiltinMelodyTier } from "./catalog";
import { getFavouriteMelodyIds, subscribeFavourites, toggleFavouriteMelody } from "./favourites";
import {
  loadBuiltinMelodiesPreferences,
  saveBuiltinMelodiesPreferences,
  type BuiltinMelodiesPreferences,
  type SortOption,
} from "./libraryPreferences";
import { useI18n } from "../i18n";
import styles from "./BuiltinMelodiesDialog.module.css";

type CatalogResult =
  | { attempt: number; state: "ready"; entries: BuiltinMelodyEntry[] }
  | { attempt: number; state: "error"; message: string };

const EMPTY_ENTRIES: BuiltinMelodyEntry[] = [];

export type { MelodyFilter, SortOption } from "./libraryPreferences";

export interface BuiltinMelodiesDialogProps {
  open: boolean;
  onClose(): void;
  onChoose(entry: BuiltinMelodyEntry): void;
  busy?: boolean;
}

function tierBadgeClass(tier: BuiltinMelodyTier): string {
  switch (tier) {
    case "Beginner":
      return styles.badgeBeginner;
    case "Intermediate":
      return styles.badgeIntermediate;
    case "Advanced":
      return styles.badgeAdvanced;
    case "Virtuoso":
      return styles.badgeVirtuoso;
  }
}

export function BuiltinMelodiesDialog({ open, onClose, onChoose, busy = false }: BuiltinMelodiesDialogProps) {
  const { dict } = useI18n();
  const searchId = useId();
  const sortId = useId();
  const [preferences, setPreferences] = useState<BuiltinMelodiesPreferences>(() => loadBuiltinMelodiesPreferences());
  const { query, activeFilter, sortBy } = preferences;
  const [favouriteIds, setFavouriteIds] = useState<ReadonlySet<string>>(() => getFavouriteMelodyIds());
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [catalogResult, setCatalogResult] = useState<CatalogResult | null>(null);

  function updatePreferences(patch: Partial<BuiltinMelodiesPreferences>): void {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    saveBuiltinMelodiesPreferences(next);
  }

  useEffect(() => {
    return subscribeFavourites((next) => {
      setFavouriteIds(new Set(next));
    });
  }, []);

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

  const filterCounts = useMemo(() => {
    let beginner = 0;
    let intermediate = 0;
    let advanced = 0;
    let favourites = 0;
    for (const entry of entries) {
      if (favouriteIds.has(entry.id)) favourites += 1;
      if (entry.difficultyTier === "Beginner") beginner += 1;
      else if (entry.difficultyTier === "Intermediate") intermediate += 1;
      else if (entry.difficultyTier === "Advanced" || entry.difficultyTier === "Virtuoso") advanced += 1;
    }
    return {
      all: entries.length,
      favourites,
      Beginner: beginner,
      Intermediate: intermediate,
      Advanced: advanced,
    };
  }, [entries, favouriteIds]);

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    let result = entries;

    if (activeFilter === "favourites") {
      result = result.filter((entry) => favouriteIds.has(entry.id));
    } else if (activeFilter === "Advanced") {
      result = result.filter((entry) => entry.difficultyTier === "Advanced" || entry.difficultyTier === "Virtuoso");
    } else if (activeFilter !== "all") {
      result = result.filter((entry) => entry.difficultyTier === activeFilter);
    }

    if (needle) {
      result = result.filter((entry) => entry.title.toLocaleLowerCase().includes(needle));
    }

    if (sortBy === "difficulty-asc") {
      return [...result].sort((a, b) => a.difficultyScore - b.difficultyScore || a.title.localeCompare(b.title));
    }
    if (sortBy === "difficulty-desc") {
      return [...result].sort((a, b) => b.difficultyScore - a.difficultyScore || a.title.localeCompare(b.title));
    }
    return [...result].sort((a, b) => a.title.localeCompare(b.title));
  }, [entries, query, activeFilter, sortBy, favouriteIds]);

  if (!open) return null;

  return (
    <StudioDialog
      screen
      title={dict.melodies.title === "Built-in Melodies" ? "Built-in melodies" : dict.melodies.title}
      description="Choose a built-in MIDI melody to open as a project."
      onClose={onClose}
    >
      <div className={styles.dialog}>
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            <span className={styles.titleIcon} aria-hidden="true"><Music2 size={20} /></span>
            <h1>{dict.melodies.title}</h1>
          </div>
          <button className={styles.close} type="button" onClick={onClose} aria-label={`${dict.common.close} ${dict.melodies.title}`}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.controls}>
          <div className={styles.searchRow}>
            <div className={styles.searchBox}>
              <label className={styles.visuallyHidden} htmlFor={searchId}>Search melodies</label>
              <Search className={styles.searchIcon} size={17} aria-hidden="true" />
              <input
                id={searchId}
                className={styles.search}
                type="search"
                value={query}
                onChange={(event) => updatePreferences({ query: event.currentTarget.value })}
                placeholder={dict.melodies.searchPlaceholder}
                autoComplete="off"
              />
            </div>
            <div className={styles.sortBox}>
              <ArrowUpDown className={styles.sortIcon} size={15} aria-hidden="true" />
              <label className={styles.visuallyHidden} htmlFor={sortId}>{dict.melodies.difficulty}</label>
              <select
                id={sortId}
                className={styles.sortSelect}
                value={sortBy}
                onChange={(event) => updatePreferences({ sortBy: event.currentTarget.value as SortOption })}
                aria-label="Sort melodies"
              >
                <option value="title">Title (A–Z)</option>
                <option value="difficulty-asc">{dict.melodies.difficulty}: Easiest first</option>
                <option value="difficulty-desc">{dict.melodies.difficulty}: Hardest first</option>
              </select>
            </div>
          </div>

          <div className={styles.filterBar} role="tablist" aria-label={dict.melodies.filterByTag}>
            <button
              className={`${styles.filterChip} ${activeFilter === "all" ? styles.filterChipActive : ""}`}
              type="button"
              role="tab"
              aria-selected={activeFilter === "all"}
              onClick={() => updatePreferences({ activeFilter: "all" })}
            >
              {dict.melodies.allTags} <span className={styles.chipCount}>({filterCounts.all})</span>
            </button>
            <button
              className={`${styles.filterChip} ${styles.chipFavourites} ${activeFilter === "favourites" ? styles.filterChipActive : ""}`}
              type="button"
              role="tab"
              aria-selected={activeFilter === "favourites"}
              onClick={() => updatePreferences({ activeFilter: "favourites" })}
            >
              <Star className={styles.chipFavouritesIcon} size={13} fill="currentColor" aria-hidden="true" />
              {dict.melodies.favourites} <span className={styles.chipCount}>({filterCounts.favourites})</span>
            </button>
            <button
              className={`${styles.filterChip} ${styles.chipBeginner} ${activeFilter === "Beginner" ? styles.filterChipActive : ""}`}
              type="button"
              role="tab"
              aria-selected={activeFilter === "Beginner"}
              onClick={() => updatePreferences({ activeFilter: "Beginner" })}
            >
              Beginner <span className={styles.chipCount}>({filterCounts.Beginner})</span>
            </button>
            <button
              className={`${styles.filterChip} ${styles.chipIntermediate} ${activeFilter === "Intermediate" ? styles.filterChipActive : ""}`}
              type="button"
              role="tab"
              aria-selected={activeFilter === "Intermediate"}
              onClick={() => updatePreferences({ activeFilter: "Intermediate" })}
            >
              Intermediate <span className={styles.chipCount}>({filterCounts.Intermediate})</span>
            </button>
            <button
              className={`${styles.filterChip} ${styles.chipAdvanced} ${activeFilter === "Advanced" ? styles.filterChipActive : ""}`}
              type="button"
              role="tab"
              aria-selected={activeFilter === "Advanced"}
              onClick={() => updatePreferences({ activeFilter: "Advanced" })}
            >
              Advanced <span className={styles.chipCount}>({filterCounts.Advanced})</span>
            </button>
          </div>

          {catalogState === "ready" && (
            <p className={styles.count} role="status" aria-live="polite" aria-atomic="true">
              {query.trim() || activeFilter !== "all"
                ? `${filteredEntries.length} of ${entries.length} melodies`
                : `${entries.length} melodies`}
            </p>
          )}
        </div>

        <div className={styles.results}>
          {catalogState === "loading" && (
            <p className={styles.message} role="status" aria-live="polite">{dict.common.loading}</p>
          )}
          {catalogState === "error" && (
            <div className={styles.error} role="alert">
              <p>{loadError}</p>
              <button className={styles.retry} type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                <RotateCw size={16} aria-hidden="true" /> {dict.common.retry}
              </button>
            </div>
          )}
          {catalogState === "ready" && filteredEntries.length === 0 && (
            <p className={styles.message} role="status">
              {query.trim()
                ? `No melodies match “${query.trim()}”.`
                : activeFilter === "favourites"
                  ? "No favourite melodies yet. Click the star icon on any melody to add it to your favourites."
                  : dict.melodies.noMelodiesFound}
            </p>
          )}
          {catalogState === "ready" && filteredEntries.length > 0 && (
            <ul className={styles.list} aria-label={dict.melodies.title}>
              {filteredEntries.map((entry) => {
                const isFav = favouriteIds.has(entry.id);
                return (
                  <li className={styles.row} key={entry.id}>
                    <div className={styles.itemCard}>
                      <button
                        className={styles.choice}
                        type="button"
                        aria-label={dict.melodies.openMelody === "Open melody" ? `Open ${entry.title}` : `${dict.melodies.openMelody} ${entry.title}`}
                        title={dict.melodies.openMelody}
                        disabled={busy}
                        onClick={() => onChoose(entry)}
                      >
                        <span className={styles.choiceIcon} aria-hidden="true"><Music2 size={18} /></span>
                        <span className={styles.copy}>
                          <span className={styles.name}>{entry.title}</span>
                          <span className={styles.metaRow}>
                            <span className={styles.meta}>{entry.fileName}</span>
                            <span className={`${styles.badge} ${tierBadgeClass(entry.difficultyTier)}`}>
                              {entry.difficultyTier} • {dict.melodies.difficulty} {entry.difficultyScore.toFixed(1)}/10
                            </span>
                          </span>
                        </span>
                      </button>
                      <button
                        className={`${styles.favouriteButton} ${isFav ? styles.favouriteButtonActive : ""}`}
                        type="button"
                        aria-label={isFav ? `${dict.melodies.removeFromFavourites}: ${entry.title}` : `${dict.melodies.addToFavourites}: ${entry.title}`}
                        title={isFav ? dict.melodies.removeFromFavourites : dict.melodies.addToFavourites}
                        aria-pressed={isFav}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleFavouriteMelody(entry.id);
                        }}
                      >
                        <Star
                          size={18}
                          fill={isFav ? "currentColor" : "none"}
                          strokeWidth={isFav ? 1.5 : 2}
                          aria-hidden="true"
                        />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {busy && <p className={styles.opening} role="status" aria-live="polite">{dict.melodies.openMelody}…</p>}
        </div>
      </div>
    </StudioDialog>
  );
}
