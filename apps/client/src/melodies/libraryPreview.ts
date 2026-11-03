import { PianoSampler } from "../audio/sampler.ts";
import type { LibraryPreviewNote } from "./libraryAnalysisClient.ts";

const DEFAULT_PREVIEW_SECONDS = 12;
const MAX_PREVIEW_SECONDS = 15;
const AUDIO_START_LEAD_SECONDS = 0.05;
const AUDIO_TAIL_SECONDS = 0.25;
const SCHEDULER_LOOKAHEAD_SECONDS = 0.1;
const SCHEDULER_INTERVAL_MS = 25;
const MAX_PREVIEW_POLYPHONY = 64;

export interface LibraryPreviewOptions {
  seconds?: number;
}

export interface LibraryPreviewHandle {
  stop(): void;
  done: Promise<void>;
}

export interface LibraryPreviewReservation {
  play(
    notes: readonly LibraryPreviewNote[],
    options?: LibraryPreviewOptions,
  ): Promise<LibraryPreviewHandle>;
  stop(): Promise<void>;
}

interface PreviewSession {
  id: number;
  context: AudioContext;
  startup: Promise<void>;
  startupError?: Error;
  sampler?: PianoSampler;
  notes?: readonly LibraryPreviewNote[];
  startAt?: number;
  finishAt?: number;
  nextNoteIndex: number;
  timer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  resolveDone: () => void;
  playing: boolean;
  stopped: boolean;
}

let activePreview: PreviewSession | null = null;
let nextSessionNumber = 0;

function makeAbortError(): Error {
  const error = new Error("The melody preview was stopped before it could start.");
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createStandaloneAudioContext(): AudioContext {
  const contextConstructor =
    typeof window !== "undefined"
      ? window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      : globalThis.AudioContext;
  if (!contextConstructor) {
    throw new Error("Web Audio API is not supported in this environment.");
  }
  return new contextConstructor();
}

function makeSession(context: AudioContext): PreviewSession {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    id: ++nextSessionNumber,
    context,
    startup: Promise.resolve(),
    nextNoteIndex: 0,
    done,
    resolveDone,
    playing: false,
    stopped: false,
  };
}

async function stopSession(session: PreviewSession): Promise<void> {
  if (session.stopped) return session.done;
  session.stopped = true;
  if (session.timer !== undefined) clearTimeout(session.timer);
  try {
    session.sampler?.dispose();
  } catch {
    // Closing the isolated context below still releases its audio nodes.
  }
  if (activePreview === session) activePreview = null;
  try {
    if (session.context.state !== "closed") await session.context.close();
  } catch {
    // A browser may reject close after the context has already shut down.
  } finally {
    session.resolveDone();
  }
  return session.done;
}

function normalizePreviewLength(options: LibraryPreviewOptions): number {
  const requestedSeconds = options.seconds ?? DEFAULT_PREVIEW_SECONDS;
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
    throw new Error("Preview length must be a positive number of seconds.");
  }
  return Math.min(MAX_PREVIEW_SECONDS, requestedSeconds);
}

function selectPreviewNotes(
  notes: readonly LibraryPreviewNote[],
  previewSeconds: number,
): LibraryPreviewNote[] {
  return notes
    .filter(
      (note) =>
        note.startSeconds < previewSeconds &&
        note.endSeconds > 0 &&
        note.endSeconds > note.startSeconds,
    )
    .map((note) => ({
      ...note,
      startSeconds: Math.max(0, note.startSeconds),
      endSeconds: Math.min(previewSeconds, note.endSeconds),
    }))
    .filter((note) => note.endSeconds > note.startSeconds)
    .sort(
      (left, right) =>
        left.startSeconds - right.startSeconds ||
        left.pitch - right.pitch ||
        left.noteId.localeCompare(right.noteId),
    );
}

function scheduleLookahead(session: PreviewSession): void {
  if (session.stopped || !session.playing || !session.sampler) return;
  const notes = session.notes!;
  const startAt = session.startAt!;
  const now = session.context.currentTime;
  const horizon = now + SCHEDULER_LOOKAHEAD_SECONDS;

  // If the tab was suspended, discard notes that have already ended instead
  // of flooding the sampler with a stale backlog when the tab resumes.
  while (
    session.nextNoteIndex < notes.length &&
    startAt + notes[session.nextNoteIndex]!.endSeconds <= now
  ) {
    session.nextNoteIndex += 1;
  }

  while (session.nextNoteIndex < notes.length) {
    if (session.sampler.getActiveVoiceCount() >= MAX_PREVIEW_POLYPHONY) break;
    const note = notes[session.nextNoteIndex]!;
    const requestedStart = startAt + note.startSeconds;
    if (requestedStart > horizon) break;

    const noteId = `library-preview-${session.id}/${note.noteId}`;
    const scheduledStart = Math.max(requestedStart, now + 0.005);
    const scheduledEnd = Math.max(startAt + note.endSeconds, scheduledStart + 0.01);
    session.sampler.noteOn(noteId, note.pitch, note.velocity, scheduledStart);
    session.sampler.noteOff(noteId, scheduledEnd);
    session.nextNoteIndex += 1;
  }

  if (now >= session.finishAt!) {
    void stopSession(session);
    return;
  }
  session.timer = setTimeout(
    () => scheduleLookahead(session),
    SCHEDULER_INTERVAL_MS,
  );
}

async function playReservedSession(
  session: PreviewSession,
  notes: readonly LibraryPreviewNote[],
  options: LibraryPreviewOptions,
): Promise<LibraryPreviewHandle> {
  if (session.startupError) throw session.startupError;
  if (session.stopped || activePreview !== session) throw makeAbortError();
  if (session.playing) throw new Error("This preview reservation has already been used.");

  let previewNotes: LibraryPreviewNote[];
  let previewSeconds: number;
  try {
    previewSeconds = normalizePreviewLength(options);
    previewNotes = selectPreviewNotes(notes, previewSeconds);
    if (previewNotes.length === 0) {
      throw new Error("This melody has no notes in the selected preview window.");
    }
  } catch (error) {
    await stopSession(session);
    throw error;
  }

  try {
    await session.startup;
    if (session.stopped || activePreview !== session) throw makeAbortError();
    session.sampler = new PianoSampler({
      audioContext: session.context,
      destinationNode: session.context.destination,
      maxPolyphony: MAX_PREVIEW_POLYPHONY,
    });
    session.notes = previewNotes;
    session.startAt = session.context.currentTime + AUDIO_START_LEAD_SECONDS;
    const lastEndSeconds = previewNotes.reduce(
      (lastEnd, note) => Math.max(lastEnd, note.endSeconds),
      0,
    );
    session.finishAt = session.startAt + lastEndSeconds + AUDIO_TAIL_SECONDS;
    session.playing = true;
    scheduleLookahead(session);
    return {
      stop: () => {
        void stopSession(session);
      },
      done: session.done,
    };
  } catch (error) {
    await stopSession(session);
    throw error;
  }
}

/**
 * Reserves and resumes an isolated audio context synchronously for a user
 * gesture. A newer reservation disposes this one; stop() only stops its own
 * reservation, so stale cleanup cannot cancel a newer preview.
 */
export function prepareLibraryPreview(): LibraryPreviewReservation {
  if (activePreview) void stopSession(activePreview);
  const session = makeSession(createStandaloneAudioContext());
  activePreview = session;
  try {
    const resume =
      session.context.state === "suspended"
        ? session.context.resume()
        : Promise.resolve();
    session.startup = Promise.resolve(resume).then(() => {
      if (session.stopped) throw makeAbortError();
    }).catch((error: unknown) => {
      session.startupError = asError(error);
      void stopSession(session);
      throw session.startupError;
    });
  } catch (error) {
    session.startupError = asError(error);
    session.startup = Promise.reject(session.startupError);
    void stopSession(session);
  }
  // Keep early autoplay rejection attached until the caller consumes it via play().
  void session.startup.catch(() => undefined);

  return {
    play: (notes, options = {}) => playReservedSession(session, notes, options),
    stop: () => stopSession(session),
  };
}

/** Starts a preview immediately; call prepareLibraryPreview first when audio
 * must be unlocked before asynchronous score loading or analysis. */
export function playLibraryPreview(
  notes: readonly LibraryPreviewNote[],
  options: LibraryPreviewOptions = {},
): Promise<LibraryPreviewHandle> {
  const reservation = prepareLibraryPreview();
  return reservation.play(notes, options);
}

/** Stops the active reservation or playback and waits for its context to close. */
export async function stopLibraryPreview(): Promise<void> {
  if (activePreview) await stopSession(activePreview);
}

