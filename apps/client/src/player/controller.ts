import {
  M1AnalyzeMidiResultSchema,
  M1ReplanDocumentRequestSchema,
  inferProjectFixtureId,
  validateM1AnalyzeMidiResultForRequest,
  validateM1ReplanDocumentResultForRequest,
  type M1AnalyzeMidiRequest,
  type M1AnalyzeMidiResult,
  type M1ReplanDocumentRequest,
  type M1ReplanDocumentResult,
  type ProjectSourceContext,
} from "@handthesia/contracts";
import { getActiveProfile } from "../profiles/profileStore";
import { createM1AnalysisWorker, postM1AnalyzeMidiRequest, postM1ReplanDocumentRequest } from "../m1WorkerClient";
import {
  computeSha256Hex,
  validateSavedProject,
  type SavedProject,
  type SessionSnapshot,
} from "../storage";
import { runWorkerJob } from "./workerJob";

export interface AnalyzeSourceOptions {
  midiBytes: ArrayBuffer;
  projectId: string;
  revision: number;
  engineVersion: string;
  sourceContext: ProjectSourceContext;
  profile?: SavedProject["profile"];
  signal: AbortSignal;
  onProgress?: (message: string, progress?: number) => void;
  allowInvalidResult?: boolean;
  onAnalysisResult?: (result: M1AnalyzeMidiResult) => void;
  worker?: Worker;
}

export async function analyzeSourceCandidate(options: AnalyzeSourceOptions): Promise<M1AnalyzeMidiResult> {
  const request: M1AnalyzeMidiRequest = {
    type: "analyze-midi",
    requestId: `studio-${crypto.randomUUID()}`,
    projectId: options.projectId,
    revision: options.revision,
    engineVersion: options.engineVersion,
    midiBytes: options.midiBytes,
    profile: options.profile ?? getActiveProfile(),
    options: {
      fixtureId: options.sourceContext.fixtureId,
      keyStyle: options.sourceContext.keyStyle,
      // The engine returns a bounded runtime initial window; canonical
      // rawBaseline and motionPlan samples remain sparse diagnostics.
      sampleDense: true,
    },
  };

  const result = await runWorkerJob(
    request,
    (worker) => postM1AnalyzeMidiRequest(worker, request),
    (message) => message.type === "analysis-result"
      ? validateM1AnalyzeMidiResultForRequest(request, message)
      : undefined,
    options.signal,
    options.onProgress,
    options.worker ? {worker:options.worker, terminateOnComplete:false} : undefined,
  );
  const validated = M1AnalyzeMidiResultSchema.parse(result);
  options.onAnalysisResult?.(validated);
  if (validated.status === "invalid" || !validated.document || !validated.performancePlan || !validated.fingeringPlan) {
    if (options.allowInvalidResult && validated.status === "invalid") return validated;
    throw new Error("The MIDI bytes did not produce a playable, valid project.");
  }
  if (validated.rawBaseline.fixtureId !== options.sourceContext.fixtureId ||
      (validated.rawBaseline.provenance?.keyStyle && validated.rawBaseline.provenance.keyStyle !== options.sourceContext.keyStyle)) {
    throw new Error("The analysis result does not match the requested source context.");
  }
  return validated;
}

/** Lease the validated Worker context to the session, or dispose it on failure. */
export async function prepareSourceCandidate(options: AnalyzeSourceOptions): Promise<{result:M1AnalyzeMidiResult; analysisWorker:Worker}> {
  const analysisWorker = createM1AnalysisWorker();
  try {
    const result = await analyzeSourceCandidate({...options, worker:analysisWorker});
    if (options.signal.aborted) throw new DOMException("Project open canceled", "AbortError");
    return {result, analysisWorker};
  } catch (error) {
    analysisWorker.terminate();
    throw error;
  }
}

/** Rebuild a saved project from its source bytes before restoring any edited plans. */
export async function analyzeSavedProjectCandidate(
  input: SavedProject,
  engineVersion: string,
  signal: AbortSignal,
  onProgress?: (message: string, progress?: number) => void,
  sourceContextOverride?: ProjectSourceContext,
): Promise<{ result: M1AnalyzeMidiResult; session: SessionSnapshot; project: SavedProject; sourceContext: ProjectSourceContext; analysisWorker:Worker }> {
  const project = validateSavedProject(input);
  const sourceDescriptor = project.document.sourceMidiResourceId
    ? project.resources?.find((resource) => resource.resourceId === project.document.sourceMidiResourceId)
    : project.resources?.find((resource) => resource.purpose === "source-midi");
  const midiBytes = project.rawMidiBytes ?? (sourceDescriptor ? project.resourcePayloads?.[sourceDescriptor.path] : undefined);
  if (!(midiBytes instanceof ArrayBuffer) || midiBytes.byteLength === 0) {
    throw new Error("This project has no recoverable original MIDI bytes. The current project remains open.");
  }
  if (sourceDescriptor) {
    if (midiBytes.byteLength !== sourceDescriptor.byteLength ||
        await computeSha256Hex(midiBytes) !== sourceDescriptor.sha256) {
      throw new Error("The saved original MIDI bytes do not match their source resource. The current project remains open.");
    }
  }
  const sourceContext = project.sourceContext ?? sourceContextOverride ?? null;
  if (!sourceContext) {
    const recoveredFixtureId = inferProjectFixtureId(project.document);
    if (!recoveredFixtureId) throw new Error("Saved project source identity is ambiguous; the original MIDI cannot be matched safely.");
    throw new Error('Legacy project source "' + recoveredFixtureId + '" has no saved keyboard geometry. Choose Realistic or Equal before opening it.');
  }
  const profile = project.profile ?? getActiveProfile();
  const {result, analysisWorker} = await prepareSourceCandidate({
    midiBytes,
    projectId: project.projectId,
    revision: project.document.revision,
    engineVersion,
    sourceContext,
    profile,
    signal,
    onProgress,
  });
  try {
  if (result.resource.byteLength !== midiBytes.byteLength || await computeSha256Hex(midiBytes) !== result.resource.sha256) {
    throw new Error("The analysis source resource does not match the saved MIDI bytes.");
  }
  assertSameSourceIdentities(project.document, result.document!);

  const plan = project.fingeringPlan ?? result.fingeringPlan!;
  if (plan.projectId !== result.projectId || plan.inputRevision !== result.revision) {
    throw new Error("Saved fingering intent does not match the reanalyzed project identity.");
  }
  if (plan.profileId !== profile.profileId || plan.profileRevision !== profile.revision) {
    throw new Error("Saved fingering intent does not match the project profile.");
  }
  const request: M1ReplanDocumentRequest = M1ReplanDocumentRequestSchema.parse({
    type: "replan-document",
    requestId: "studio-replan-" + crypto.randomUUID(),
    projectId: project.projectId,
    revision: project.document.revision,
    engineVersion,
    midiBytes,
    document: project.document,
    // Only the source document and manual intent survive an engine change.
    // The receiving engine must see its own version on the draft metadata.
    fingeringPlan: { ...plan, engineVersion },
    profile,
    resource: result.resource,
    rawBaseline: result.rawBaseline,
    options: { fixtureId: sourceContext.fixtureId, keyStyle: sourceContext.keyStyle },
  });
  const replanned = await runWorkerJob<M1ReplanDocumentResult>(
    request,
    (worker) => postM1ReplanDocumentRequest(worker, request),
    (message) => message.type === "replan-document-result"
      ? validateM1ReplanDocumentResultForRequest(request, message)
      : undefined,
    signal,
    onProgress,
    {worker:analysisWorker, terminateOnComplete:false},
  );
  if (signal.aborted) throw new DOMException("Project open canceled", "AbortError");
  const { keyStyle: calculatedKeyStyle, ...analysisEnvelope } = replanned;
  const settledResult = M1AnalyzeMidiResultSchema.parse({ ...analysisEnvelope, type: "analysis-result" });
  if (calculatedKeyStyle !== sourceContext.keyStyle || settledResult.status === "invalid" ||
      !settledResult.document || !settledResult.fingeringPlan || !settledResult.performancePlan) {
    throw new Error("The saved fingering intent could not be replanned into a playable project.");
  }
  const session: SessionSnapshot = {
    projectId: project.projectId,
    updatedAt: Date.now(),
    result: settledResult,
    rawMidiBytes: midiBytes,
    profile,
    document: settledResult.document,
    fingeringPlan: settledResult.fingeringPlan,
    draftFingeringPlan: settledResult.fingeringPlan,
    activeProfileId: profile.profileId,
    plansState: "valid",
    keyStyle: sourceContext.keyStyle,
    sourceContext,
    sourceDescriptor: settledResult.resource,
    ...(project.practiceState ? { practiceState: project.practiceState } : {}),
  };
  return {
    result: settledResult,
    analysisWorker,
    session,
    project: {
      ...project,
      rawMidiBytes: midiBytes,
      profile,
      sourceContext,
      document: settledResult.document,
      fingeringPlan: settledResult.fingeringPlan,
      performancePlan: settledResult.performancePlan,
      motionPlan: settledResult.motionPlan,
      resources: [settledResult.resource],
    },
    sourceContext,
  };
  } catch (error) {
    analysisWorker.terminate();
    throw error;
  }
}

export function assertSameSourceIdentities(expected: SavedProject["document"], actual: NonNullable<M1AnalyzeMidiResult["document"]>): void {
  const expectedNotes = new Map(expected.notes.map((note) => [note.noteId, note]));
  const actualNotes = new Map(actual.notes.map((note) => [note.noteId, note]));
  if (expectedNotes.size !== actualNotes.size || [...expectedNotes.keys()].some((id) => !actualNotes.has(id))) {
    throw new Error("The source bytes no longer produce the saved note identities. The project was not applied.");
  }
  for (const [noteId, sourceNote] of actualNotes) {
    const savedNote = expectedNotes.get(noteId)!;
    const sourceIds = (note: typeof sourceNote) => [...(note.sourceNoteIds ?? [])].sort();
    const immutableSource = (note: typeof sourceNote) => ({
      noteId: note.noteId,
      trackId: note.trackId,
      pitch: note.pitch,
      velocity: note.velocity,
      startSeconds: note.startSeconds,
      endSeconds: note.endSeconds,
      sourceEvent: note.sourceEvent ?? null,
    });
    if (JSON.stringify(sourceIds(savedNote)) !== JSON.stringify(sourceIds(sourceNote))) {
      throw new Error("Saved source-note IDs for " + noteId + " do not match this MIDI. The project was not applied.");
    }
    if (JSON.stringify(immutableSource(savedNote)) !== JSON.stringify(immutableSource(sourceNote))) {
      throw new Error("Saved source attributes for " + noteId + " do not match this MIDI. The project was not applied.");
    }
  }
  const tracks = (document: typeof expected) => document.tracks
    .map(({ trackId, instrumentIndex, sourceMidiTrackIndex, channel, name, program }) =>
      ({ trackId, instrumentIndex, sourceMidiTrackIndex: sourceMidiTrackIndex ?? null, channel: channel ?? null, name, program }))
    .sort((a, b) => a.trackId.localeCompare(b.trackId));
  if (JSON.stringify(tracks(expected)) !== JSON.stringify(tracks(actual))) {
    throw new Error("Saved track identities or source references do not match this MIDI. The project was not applied.");
  }
}
