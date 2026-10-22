import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Bookmark, Check, Pencil, Play, RotateCcw, Trash2, X } from "lucide-react";
import { PRACTICE_MIN_LOOP_SECONDS, type PracticeLoop, type PracticeState } from "@handthesia/contracts";
import { useI18n } from "../i18n";
import styles from "./PracticePanel.module.css";

export type PracticePanelBookmark = PracticeState["bookmarks"][number];

export interface PracticePanelProps {
  currentTimeSeconds: number;
  durationSeconds: number;
  loop: PracticeLoop | null;
  bookmarks: PracticePanelBookmark[];
  disabled?: boolean;
  loopAvailable?: boolean;
  onSetLoopStart: (seconds: number) => void;
  onSetLoopEnd: (seconds: number) => void;
  onLoopEnabledChange: (enabled: boolean) => void;
  onResetLoop: () => void;
  onAddBookmark: (name: string, timeSeconds: number) => void;
  onJumpToBookmark: (id: string) => void;
  onRenameBookmark: (id: string, name: string) => void;
  onDeleteBookmark: (id: string) => void;
  onOpenPlayAlong?: () => void;
}

interface LoopDraftState {
  sourceStart: number;
  sourceEnd: number;
  sourceDuration: number;
  start: string;
  end: string;
  error: string | null;
  errorField: "start" | "end" | null;
}

const LOOP_SPAN_TOLERANCE_SECONDS = 1e-9;
const MAX_BOOKMARK_NAME_LENGTH = 120;

function timeText(value: number, max = Number.POSITIVE_INFINITY): string {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, value)).toFixed(2) : "0.00";
}

function roundTime(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseTime(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function PracticePanel({
  currentTimeSeconds,
  durationSeconds,
  loop,
  bookmarks,
  disabled = false,
  loopAvailable = true,
  onSetLoopStart,
  onSetLoopEnd,
  onLoopEnabledChange,
  onResetLoop,
  onAddBookmark,
  onJumpToBookmark,
  onRenameBookmark,
  onDeleteBookmark,
  onOpenPlayAlong,
}: PracticePanelProps) {
  const { dict, t } = useI18n();
  const practiceId = useId().replace(/:/g, "");
  const loopErrorId = `${practiceId}-loop-error`;
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const maxEditableDuration = Math.floor((duration + LOOP_SPAN_TOLERANCE_SECONDS) * 100) / 100;
  const loopStart = loop?.startSeconds ?? 0;
  const loopEnd = loop?.endSeconds ?? duration;
  const [loopDraft, setLoopDraft] = useState<LoopDraftState>(() => ({
    sourceStart: loopStart,
    sourceEnd: loopEnd,
    sourceDuration: duration,
    start: timeText(loopStart),
    end: timeText(loopEnd, maxEditableDuration),
    error: null,
    errorField: null,
  }));
  if (loopDraft.sourceStart !== loopStart || loopDraft.sourceEnd !== loopEnd || loopDraft.sourceDuration !== duration) {
    setLoopDraft({
      sourceStart: loopStart,
      sourceEnd: loopEnd,
      sourceDuration: duration,
      start: timeText(loopStart),
      end: timeText(loopEnd, maxEditableDuration),
      error: null,
      errorField: null,
    });
  }
  const { start: startDraft, end: endDraft, error: loopError, errorField: loopErrorField } = loopDraft;
  const setStartDraft = (start: string) => setLoopDraft((current) => ({ ...current, start }));
  const setEndDraft = (end: string) => setLoopDraft((current) => ({ ...current, end }));
  const showLoopError = (error: string, field: "start" | "end") => setLoopDraft((current) => ({ ...current, error, errorField: field }));
  const clearLoopError = () => setLoopDraft((current) => ({ ...current, error: null, errorField: null }));
  const [bookmarkName, setBookmarkName] = useState("");
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState(false);
  const renameTriggerRefs = useRef(new Map<string, HTMLButtonElement>());

  const sortedBookmarks = useMemo(() => bookmarks
    .map((bookmark, index) => ({ bookmark, index }))
    .sort((left, right) => left.bookmark.timeSeconds - right.bookmark.timeSeconds || left.index - right.index)
    .map(({ bookmark }) => bookmark), [bookmarks]);
  const hasBookmarkOutsideLoop = Boolean(loop?.enabled && sortedBookmarks.some((bookmark) =>
    bookmark.timeSeconds < loop.startSeconds || bookmark.timeSeconds >= loop.endSeconds));

  const validateRange = (start: number, end: number): string | null => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return dict.practice.invalidLoopTime;
    if (start < 0 || end < 0 || start > duration || end > duration) return dict.practice.loopPointOutsideDuration;
    if (end - start < PRACTICE_MIN_LOOP_SECONDS - LOOP_SPAN_TOLERANCE_SECONDS) return dict.practice.invalidLoopRange;
    return null;
  };

  const canEditLoop = !disabled && duration >= PRACTICE_MIN_LOOP_SECONDS;
  const activeRangeError = validateRange(loopStart, loopEnd);
  const loopMessage = loopError || (!loopAvailable ? dict.practice.loopUnavailable : activeRangeError);

  const resetLoop = () => {
    setStartDraft("0.00");
    setEndDraft(timeText(duration, maxEditableDuration));
    clearLoopError();
    onResetLoop();
  };

  const commitLoopValue = (field: "start" | "end", value: string): boolean => {
    const parsed = parseTime(value);
    if (parsed === null) {
      showLoopError(dict.practice.invalidLoopTime, field);
      return false;
    }
    const rounded = roundTime(parsed);
    const candidateError = field === "start"
      ? validateRange(rounded, loopEnd)
      : validateRange(loopStart, rounded);
    if (candidateError) {
      showLoopError(candidateError, field);
      return false;
    }
    clearLoopError();
    if (field === "start") {
      setStartDraft(timeText(rounded, maxEditableDuration));
      onSetLoopStart(rounded);
    } else {
      setEndDraft(timeText(rounded, maxEditableDuration));
      onSetLoopEnd(rounded);
    }
    return true;
  };

  const setLoopPointToPlayhead = (field: "start" | "end") => {
    const candidate = Math.min(maxEditableDuration, Math.max(0, roundTime(currentTimeSeconds)));
    const candidateError = field === "start"
      ? validateRange(candidate, loopEnd)
      : validateRange(loopStart, candidate);
    if (candidateError) {
      showLoopError(candidateError, field);
      return;
    }
    clearLoopError();
    if (field === "start") {
      setStartDraft(timeText(candidate, maxEditableDuration));
      onSetLoopStart(candidate);
    } else {
      setEndDraft(timeText(candidate, maxEditableDuration));
      onSetLoopEnd(candidate);
    }
  };

  const handleLoopKeyDown = (field: "start" | "end", event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitLoopValue(field, event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (field === "start") setStartDraft(timeText(loopStart, maxEditableDuration));
      else setEndDraft(timeText(loopEnd, maxEditableDuration));
      clearLoopError();
    }
  };

  const addBookmark = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let name = bookmarkName.trim();
    if (!name) {
      let number = bookmarks.length + 1;
      name = t("practice.defaultBookmarkName", { number });
      while (bookmarks.some((bookmark) => bookmark.name === name)) {
        number += 1;
        name = t("practice.defaultBookmarkName", { number });
      }
    }
    onAddBookmark(name.slice(0, MAX_BOOKMARK_NAME_LENGTH), Math.min(duration, Math.max(0, currentTimeSeconds)));
    setBookmarkName("");
  };

  const startRename = (bookmark: PracticePanelBookmark) => {
    setEditingBookmarkId(bookmark.id);
    setRenameDraft(bookmark.name);
    setRenameError(false);
  };

  const restoreRenameFocus = (id: string | null) => {
    if (!id) return;
    requestAnimationFrame(() => {
      const trigger = renameTriggerRefs.current.get(id);
      if (trigger?.isConnected) trigger.focus();
    });
  };

  const cancelRename = (id: string | null = editingBookmarkId) => {
    setEditingBookmarkId(null);
    setRenameDraft("");
    setRenameError(false);
    restoreRenameFocus(id);
  };

  const saveRename = (id: string) => {
    const name = renameDraft.trim();
    if (!name) {
      setRenameError(true);
      return;
    }
    onRenameBookmark(id, name.slice(0, MAX_BOOKMARK_NAME_LENGTH));
    cancelRename(id);
  };

  const renameKeyDown = (id: string, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveRename(id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelRename(id);
    }
  };

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby={`${practiceId}-loop-heading`}>
        <div className={styles.sectionHeading}>
          <div>
            <h3 id={`${practiceId}-loop-heading`}>{dict.practice.loopSection}</h3>
            <p className={styles.sectionDescription}>{dict.practice.panelDescription}</p>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            disabled={!canEditLoop}
            onClick={resetLoop}
            aria-label={dict.practice.resetRepeat}
            title={dict.practice.resetRepeat}
          ><RotateCcw size={16} aria-hidden="true" /></button>
        </div>
        <div className={styles.loopGrid}>
          <div className={styles.timeField}>
            <label htmlFor={`${practiceId}-loop-start`}>{dict.practice.loopStart}</label>
            <input
              id={`${practiceId}-loop-start`}
              type="number"
              inputMode="decimal"
              min={0}
              max={maxEditableDuration}
              step={0.01}
              value={startDraft}
              disabled={!canEditLoop}
              aria-invalid={Boolean((loopError && loopErrorField === "start") || activeRangeError)}
              aria-describedby={loopMessage ? loopErrorId : undefined}
              onChange={(event) => { setStartDraft(event.currentTarget.value); }}
              onBlur={(event) => commitLoopValue("start", event.currentTarget.value)}
              onKeyDown={(event) => handleLoopKeyDown("start", event)}
            />
            <button type="button" className={styles.secondaryButton} disabled={!canEditLoop} onClick={() => setLoopPointToPlayhead("start")}>
              {dict.practice.setStartAtPlayhead}
            </button>
          </div>
          <div className={styles.timeField}>
            <label htmlFor={`${practiceId}-loop-end`}>{dict.practice.loopEnd}</label>
            <input
              id={`${practiceId}-loop-end`}
              type="number"
              inputMode="decimal"
              min={0}
              max={maxEditableDuration}
              step={0.01}
              value={endDraft}
              disabled={!canEditLoop}
              aria-invalid={Boolean((loopError && loopErrorField === "end") || activeRangeError)}
              aria-describedby={loopMessage ? loopErrorId : undefined}
              onChange={(event) => { setEndDraft(event.currentTarget.value); }}
              onBlur={(event) => commitLoopValue("end", event.currentTarget.value)}
              onKeyDown={(event) => handleLoopKeyDown("end", event)}
            />
            <button type="button" className={styles.secondaryButton} disabled={!canEditLoop} onClick={() => setLoopPointToPlayhead("end")}>
              {dict.practice.setEndAtPlayhead}
            </button>
          </div>
        </div>
        {loopMessage && (
          <p id={loopErrorId} className={styles.message} role="status">
            {loopMessage}
          </p>
        )}
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={loop?.enabled ?? false}
            disabled={!canEditLoop || (!loop?.enabled && (!loopAvailable || Boolean(activeRangeError) || Boolean(loopError)))}
            onChange={(event) => onLoopEnabledChange(event.currentTarget.checked)}
          />
          <span>{dict.practice.repeatEnabled}</span>
        </label>
      </section>

      <section className={styles.section} aria-labelledby={`${practiceId}-bookmarks-heading`}>
        <div className={styles.sectionHeading}>
          <div><h3 id={`${practiceId}-bookmarks-heading`}>{dict.practice.bookmarkSection}</h3></div>
          <Bookmark size={17} aria-hidden="true" />
        </div>
        <form className={styles.addForm} onSubmit={addBookmark}>
          <div className={styles.nameField}>
            <label htmlFor={`${practiceId}-bookmark-name`}>{dict.practice.bookmarkName}</label>
            <input
              id={`${practiceId}-bookmark-name`}
              type="text"
              value={bookmarkName}
              maxLength={MAX_BOOKMARK_NAME_LENGTH}
              placeholder={dict.practice.bookmarkNamePlaceholder}
              disabled={disabled || duration <= 0}
              onChange={(event) => { setBookmarkName(event.currentTarget.value); }}
            />
          </div>
          <button type="submit" className={styles.primaryButton} aria-label={dict.practice.addBookmark} disabled={disabled || duration <= 0}>
            <Bookmark size={15} aria-hidden="true" />
            {dict.practice.addBookmarkAtCurrentTime}
          </button>
        </form>
        {hasBookmarkOutsideLoop && <p className={styles.hint}>{dict.practice.bookmarkRepeatHint}</p>}
        {sortedBookmarks.length === 0 ? (
          <p className={styles.emptyHint}>{dict.practice.noBookmarks}</p>
        ) : (
          <ul className={styles.bookmarkList}>
            {sortedBookmarks.map((bookmark, index) => (
              <li className={styles.bookmarkItem} key={bookmark.id}>
                {editingBookmarkId === bookmark.id ? (
                  <div className={styles.renameEditor}>
                    <input
                      type="text"
                      value={renameDraft}
                      maxLength={MAX_BOOKMARK_NAME_LENGTH}
                      autoFocus
                      disabled={disabled}
                      aria-label={dict.practice.renameBookmark}
                      aria-invalid={renameError}
                      aria-describedby={renameError ? `${practiceId}-rename-error-${index}` : undefined}
                      onChange={(event) => { setRenameDraft(event.currentTarget.value); setRenameError(false); }}
                      onKeyDown={(event) => renameKeyDown(bookmark.id, event)}
                    />
                    <button type="button" className={styles.iconButton} disabled={disabled} aria-label={dict.practice.saveBookmarkName} title={dict.practice.saveBookmarkName} onClick={() => saveRename(bookmark.id)}><Check size={16} aria-hidden="true" /></button>
                    <button type="button" className={styles.iconButton} aria-label={dict.practice.cancelRename} title={dict.practice.cancelRename} onClick={() => cancelRename(bookmark.id)}><X size={16} aria-hidden="true" /></button>
                    {renameError && <p id={`${practiceId}-rename-error-${index}`} className={styles.message} role="alert">{dict.practice.bookmarkNameRequired}</p>}
                  </div>
                ) : (
                  <>
                    <button type="button" className={styles.jumpButton} onClick={() => onJumpToBookmark(bookmark.id)} disabled={disabled} aria-label={`${dict.practice.jumpToBookmark}: ${bookmark.name}, ${timeText(bookmark.timeSeconds)} ${dict.practice.secondsUnit}`}>
                      <span className={styles.bookmarkName}><Bookmark size={14} aria-hidden="true" />{bookmark.name}</span>
                      <span className={styles.timestamp}>{timeText(bookmark.timeSeconds)} {dict.practice.secondsUnit}</span>
                    </button>
                    <div className={styles.bookmarkActions}>
                      <button
                        ref={(element) => {
                          if (element) renameTriggerRefs.current.set(bookmark.id, element);
                          else renameTriggerRefs.current.delete(bookmark.id);
                        }}
                        type="button"
                        className={styles.iconButton}
                        disabled={disabled}
                        aria-label={`${dict.practice.renameBookmark}: ${bookmark.name}`}
                        title={dict.practice.renameBookmark}
                        onClick={() => startRename(bookmark)}
                      ><Pencil size={15} aria-hidden="true" /></button>
                      <button type="button" className={styles.iconButton} disabled={disabled} aria-label={`${dict.practice.deleteBookmark}: ${bookmark.name}`} title={dict.practice.deleteBookmark} onClick={() => onDeleteBookmark(bookmark.id)}><Trash2 size={15} aria-hidden="true" /></button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {onOpenPlayAlong && (
        <button type="button" className={styles.playAlongButton} disabled={disabled} onClick={onOpenPlayAlong}>
          <Play size={16} aria-hidden="true" />
          {dict.playback.playAlong}
        </button>
      )}
    </div>
  );
}

export default PracticePanel;
