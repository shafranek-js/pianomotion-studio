import type { FingeringPlan, Note, PerformancePlan } from "@handthesia/contracts";

export type PlayAlongHandMode = "both" | "right" | "left";
export type PlayAlongState = "idle" | "waiting" | "held" | "transitioning" | "completed";

export interface PlayAlongNote {
  noteId: string;
  pitch: number;
  hand: "left" | "right";
  finger: number | null;
  startSeconds: number;
  endSeconds: number;
}

export interface PlayAlongStep {
  index: number;
  timeSeconds: number;
  durationSeconds: number;
  notes: PlayAlongNote[];
  targetPitches: Set<number>;
  activePitches: Set<number>;
  sustainedPitches: Set<number>;
  handAssignments: Map<number, { hand: "left" | "right"; finger: number | null }>;
}

export interface PlayAlongEngineOptions {
  notes: Note[];
  fingeringPlan?: FingeringPlan | null;
  performancePlan?: Pick<PerformancePlan, "events"> | null;
  handMode?: PlayAlongHandMode;
  autoPlayOtherHand?: boolean;
  transitionDurationMs?: number;
  onStepChange?: (step: PlayAlongStep | null, state: PlayAlongState) => void;
  onStateChange?: (state: PlayAlongState) => void;
  onTimeChange?: (timeSeconds: number) => void;
  /** Optional stable voice identity; legacy callbacks may ignore this argument. */
  onPlayNote?: (pitch: number, velocity: number, voiceId?: string) => void;
  /** Optional stable voice identity; legacy callbacks may ignore this argument. */
  onStopNote?: (pitch: number, voiceId?: string) => void;
  onWrongNote?: (pitch: number) => void;
  onChordHit?: (step: PlayAlongStep) => void;
}

export interface PlayAlongLoopRange {
  startSeconds: number;
  endSeconds: number;
}

export const CLUSTER_WINDOW_SECONDS = 0.045; // 45ms chord onset cluster window
export const DEFAULT_TRANSITION_MS = 250;

const safeRaf = typeof requestAnimationFrame !== "undefined"
  ? requestAnimationFrame
  : (cb: (time: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number;

const safeCaf = typeof cancelAnimationFrame !== "undefined"
  ? cancelAnimationFrame
  : (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

/** Clusters notes into sequential chord/note steps by onset time. */
export function clusterNotesIntoSteps(
  notes: Note[],
  fingeringPlan?: FingeringPlan | null,
  handMode: PlayAlongHandMode = "both",
  performancePlan?: Pick<PerformancePlan, "events"> | null,
): PlayAlongStep[] {
  if (!notes || notes.length === 0) return [];

  const assignmentByNoteId = new Map(
    (fingeringPlan?.assignments ?? []).map((a) => [a.noteId, a]),
  );

  const pressByNoteId = new Map<string, number>();
  const releaseByNoteId = new Map<string, number>();
  if (performancePlan?.events) {
    for (const ev of performancePlan.events) {
      if (ev.type === "press") pressByNoteId.set(ev.noteId, ev.timeSeconds);
      else if (ev.type === "release") releaseByNoteId.set(ev.noteId, ev.timeSeconds);
    }
  }

  // All playable notes with resolved hands, fingers, and performed timings
  const allPlayableNotes: PlayAlongNote[] = [];
  for (const rawNote of notes) {
    const a = assignmentByNoteId.get(rawNote.noteId);
    if (a?.disposition === "unplayable") continue;
    const hand = a?.hand ?? rawNote.hand;
    const finger = a?.finger ?? rawNote.finger ?? null;
    const startSeconds = pressByNoteId.get(rawNote.noteId) ?? rawNote.startSeconds;
    const rawEnd = releaseByNoteId.get(rawNote.noteId) ?? rawNote.endSeconds;
    const endSeconds = rawEnd > startSeconds ? rawEnd : Math.max(startSeconds + 0.05, rawNote.endSeconds);
    allPlayableNotes.push({
      noteId: rawNote.noteId,
      pitch: rawNote.pitch,
      hand,
      finger,
      startSeconds,
      endSeconds,
    });
  }

  if (allPlayableNotes.length === 0) return [];

  // Filter for practice mode:
  // If handMode === "right", only right hand notes drive the steps.
  // If handMode === "left", only left hand notes drive the steps.
  // If handMode === "both", all notes drive the steps.
  const drivingNotes = allPlayableNotes
    .filter((n) => {
      if (handMode === "right") return n.hand === "right";
      if (handMode === "left") return n.hand === "left";
      return true;
    })
    .sort((a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch);

  if (drivingNotes.length === 0) return [];

  const steps: PlayAlongStep[] = [];
  let currentCluster: PlayAlongNote[] = [];
  let clusterStartTime = drivingNotes[0]!.startSeconds;

  const flushCluster = () => {
    if (currentCluster.length === 0) return;

    const minTime = currentCluster.reduce((min, n) => Math.min(min, n.startSeconds), currentCluster[0]!.startSeconds);
    const maxEnd = currentCluster.reduce((max, n) => Math.max(max, n.endSeconds), currentCluster[0]!.endSeconds);
    const activePitches = new Set(currentCluster.map((n) => n.pitch));
    const handAssignments = new Map<number, { hand: "left" | "right"; finger: number | null }>();

    for (const note of currentCluster) {
      handAssignments.set(note.pitch, { hand: note.hand, finger: note.finger });
    }

    // Identify notes that are actively sounding (sustained) during this step
    // but were struck in earlier steps
    const sustainedPitches = new Set<number>();
    for (const n of allPlayableNotes) {
      if (handMode === "right" && n.hand !== "right") continue;
      if (handMode === "left" && n.hand !== "left") continue;
      // Started before this cluster and still sounding
      if (n.startSeconds < minTime - CLUSTER_WINDOW_SECONDS && n.endSeconds > minTime + 0.05) {
        sustainedPitches.add(n.pitch);
        if (!handAssignments.has(n.pitch)) {
          handAssignments.set(n.pitch, { hand: n.hand, finger: n.finger });
        }
      }
    }

    const targetPitches = new Set([...activePitches, ...sustainedPitches]);

    steps.push({
      index: steps.length,
      timeSeconds: minTime,
      durationSeconds: Math.max(0.05, maxEnd - minTime),
      notes: currentCluster,
      targetPitches,
      activePitches,
      sustainedPitches,
      handAssignments,
    });

    currentCluster = [];
  };

  for (const note of drivingNotes) {
    if (note.startSeconds - clusterStartTime <= CLUSTER_WINDOW_SECONDS) {
      currentCluster.push(note);
    } else {
      flushCluster();
      clusterStartTime = note.startSeconds;
      currentCluster.push(note);
    }
  }

  flushCluster();
  return steps;
}

export class PlayAlongEngine {
  private steps: PlayAlongStep[] = [];
  private allPlayableNotes: PlayAlongNote[] = [];
  private currentStepIndex = 0;
  private state: PlayAlongState = "idle";
  private handMode: PlayAlongHandMode = "both";
  private autoPlayOtherHand = true;
  private transitionDurationMs = DEFAULT_TRANSITION_MS;

  private readonly heldUserPitches = new Set<number>();
  private readonly completedPitchesInStep = new Set<number>();
  private readonly waitReleasePitches = new Set<number>();
  private previousStepPitches = new Set<number>();
  private transitionRaf: number | null = null;
  private transitionStartTime = 0;
  private transitionFromTime = 0;
  private transitionToTime = 0;
  private loopRange: PlayAlongLoopRange | null = null;
  private companionGeneration = 0;
  private companionVoiceSequence = 0;
  private readonly pendingCompanionTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly activeCompanionVoices = new Map<string, {
    pitch: number;
    releaseTimer: ReturnType<typeof setTimeout>;
  }>();

  private readonly options: PlayAlongEngineOptions;

  constructor(options: PlayAlongEngineOptions) {
    this.options = options;
    this.handMode = options.handMode ?? "both";
    this.autoPlayOtherHand = options.autoPlayOtherHand ?? true;
    this.transitionDurationMs = options.transitionDurationMs ?? DEFAULT_TRANSITION_MS;
    this.rebuildSteps();
  }

  public rebuildSteps(): void {
    this.cancelCompanionAudio();
    const assignmentByNoteId = new Map(
      (this.options.fingeringPlan?.assignments ?? []).map((a) => [a.noteId, a]),
    );
    const pressByNoteId = new Map<string, number>();
    const releaseByNoteId = new Map<string, number>();
    if (this.options.performancePlan?.events) {
      for (const ev of this.options.performancePlan.events) {
        if (ev.type === "press") pressByNoteId.set(ev.noteId, ev.timeSeconds);
        else if (ev.type === "release") releaseByNoteId.set(ev.noteId, ev.timeSeconds);
      }
    }

    this.allPlayableNotes = (this.options.notes ?? [])
      .filter((n) => assignmentByNoteId.get(n.noteId)?.disposition !== "unplayable")
      .map((n) => {
        const a = assignmentByNoteId.get(n.noteId);
        const startSeconds = pressByNoteId.get(n.noteId) ?? n.startSeconds;
        const rawEnd = releaseByNoteId.get(n.noteId) ?? n.endSeconds;
        const endSeconds = rawEnd > startSeconds ? rawEnd : Math.max(startSeconds + 0.05, n.endSeconds);
        return {
          noteId: n.noteId,
          pitch: n.pitch,
          hand: a?.hand ?? n.hand,
          finger: a?.finger ?? n.finger ?? null,
          startSeconds,
          endSeconds,
        };
      });

    this.steps = clusterNotesIntoSteps(
      this.options.notes,
      this.options.fingeringPlan,
      this.handMode,
      this.options.performancePlan,
    );
    if (this.currentStepIndex >= this.steps.length) {
      this.currentStepIndex = Math.max(0, this.steps.length - 1);
    }
  }

  public start(): void {
    const eligible = this.getEligibleStepIndices();
    if (eligible.length === 0) {
      this.currentStepIndex = -1;
      this.cancelCompanionAudio();
      this.setState("completed");
      this.options.onStepChange?.(null, this.state);
      return;
    }
    this.seekToStep(eligible[0]!);
  }

  /**
   * Seeks to the eligible step nearest to a musical time. Used when a replan
   * rebuilds the engine so the current play-along position is preserved.
   */
  public seekToTime(timeSeconds: number): void {
    const eligible = this.getEligibleStepIndices();
    if (eligible.length === 0) {
      this.currentStepIndex = -1;
      this.cancelCompanionAudio();
      this.setState("completed");
      this.options.onStepChange?.(null, this.state);
      return;
    }
    let bestIndex = eligible[0]!;
    let bestDiff = Infinity;
    for (const index of eligible) {
      const diff = Math.abs(this.steps[index]!.timeSeconds - timeSeconds);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIndex = index;
      }
    }
    this.seekToStep(bestIndex);
  }

  public stop(): void {
    this.cancelCompanionAudio();
    this.cancelTransition();
    this.stopUserVoices();
    this.heldUserPitches.clear();
    this.completedPitchesInStep.clear();
    this.waitReleasePitches.clear();
    this.previousStepPitches.clear();
    this.setState("idle");
  }

  public setHandMode(mode: PlayAlongHandMode): void {
    if (this.handMode === mode) return;
    this.cancelCompanionAudio();
    const prevTime = this.getCurrentStep()?.timeSeconds ?? 0;
    this.handMode = mode;
    this.rebuildSteps();
    const eligible = this.getEligibleStepIndices();
    if (eligible.length === 0) {
      this.currentStepIndex = -1;
      this.setState("completed");
      this.options.onStepChange?.(null, this.state);
      return;
    }
    let bestIdx = eligible[0]!;
    let bestDiff = Infinity;
    for (const i of eligible) {
      const diff = Math.abs(this.steps[i]!.timeSeconds - prevTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    this.seekToStep(bestIdx);
  }

  public getHandMode(): PlayAlongHandMode {
    return this.handMode;
  }

  public setAutoPlayOtherHand(enabled: boolean): void {
    if (this.autoPlayOtherHand && !enabled) this.cancelCompanionAudio();
    this.autoPlayOtherHand = enabled;
  }

  public getAutoPlayOtherHand(): boolean {
    return this.autoPlayOtherHand;
  }

  /** Restricts practice navigation to steps whose onset is inside [A, B). */
  public setLoopRange(range: PlayAlongLoopRange | null): void {
    this.cancelCompanionAudio();
    const wasTransitioning = this.state === "transitioning";
    this.cancelTransition();
    this.loopRange = range && Number.isFinite(range.startSeconds) && Number.isFinite(range.endSeconds) &&
      range.startSeconds >= 0 && range.endSeconds - range.startSeconds >= 0.1 - 1e-9
      ? { startSeconds: range.startSeconds, endSeconds: range.endSeconds }
      : null;

    if (!this.loopRange) {
      if (wasTransitioning) this.completeTransitionInstantly();
      return;
    }
    const eligible = this.getEligibleStepIndices();
    if (eligible.length === 0) {
      this.currentStepIndex = -1;
      if (this.state !== "idle") {
        this.setState("completed");
        this.options.onStepChange?.(null, this.state);
      }
      return;
    }
    if (!eligible.includes(this.currentStepIndex)) {
      if (this.state === "idle") this.currentStepIndex = eligible[0]!;
      else this.seekToStep(eligible[0]!);
    } else if (wasTransitioning) {
      this.completeTransitionInstantly();
    }
  }

  public hasEligibleLoopSteps(): boolean {
    return this.getEligibleStepIndices().length > 0;
  }

  private getEligibleStepIndices(): number[] {
    const indices: number[] = [];
    for (let index = 0; index < this.steps.length; index += 1) {
      const time = this.steps[index]!.timeSeconds;
      if (!this.loopRange || (time >= this.loopRange.startSeconds && time < this.loopRange.endSeconds)) {
        indices.push(index);
      }
    }
    return indices;
  }

  private getNextEligibleIndex(index: number): number | null {
    const eligible = this.getEligibleStepIndices();
    if (eligible.length === 0) return null;
    const next = eligible.find((candidate) => candidate > index);
    if (next !== undefined) return next;
    if (this.loopRange) return eligible[0]!;
    return null;
  }

  private getPreviousEligibleIndex(index: number): number | null {
    const eligible = this.getEligibleStepIndices();
    if (eligible.length === 0) return null;
    for (let offset = eligible.length - 1; offset >= 0; offset -= 1) {
      const candidate = eligible[offset]!;
      if (candidate < index) return candidate;
    }
    if (this.loopRange) return eligible[eligible.length - 1]!;
    return null;
  }

  public setTransitionDurationMs(ms: number): void {
    this.transitionDurationMs = Math.max(0, ms);
  }

  public getState(): PlayAlongState {
    return this.state;
  }

  public getSteps(): PlayAlongStep[] {
    return this.steps;
  }

  public getCurrentStep(): PlayAlongStep | null {
    return this.steps[this.currentStepIndex] ?? null;
  }

  public getCurrentStepIndex(): number {
    return this.currentStepIndex;
  }

  public getHeldUserPitches(): ReadonlySet<number> {
    return this.heldUserPitches;
  }

  public getCompletedPitchesInStep(): ReadonlySet<number> {
    return this.completedPitchesInStep;
  }

  public noteOn(pitch: number, velocity = 80): void {
    if (this.state === "transitioning") {
      this.completeTransitionInstantly();
    } else if (this.state === "held") {
      const currentStep = this.getCurrentStep();
      if (
        currentStep &&
        !currentStep.activePitches.has(pitch) &&
        !currentStep.sustainedPitches.has(pitch) &&
        !this.isPitchSustainedInPiece(pitch, currentStep.timeSeconds) &&
        this.isPitchInNextStep(pitch)
      ) {
        // Legato advancement: current step already satisfied, user struck next step's note before releasing
        this.advanceToNextStep();
        this.completeTransitionInstantly();
      }
    }

    this.heldUserPitches.add(pitch);
    this.options.onPlayNote?.(pitch, velocity, this.userVoiceId(pitch));

    if (this.state !== "waiting" && this.state !== "held") {
      return;
    }

    const step = this.getCurrentStep();
    if (!step) return;

    if (step.activePitches.has(pitch)) {
      this.completedPitchesInStep.add(pitch);

      const allSatisfied = Array.from(step.activePitches).every((p) => this.completedPitchesInStep.has(p));
      if (allSatisfied) {
        if (this.state === "waiting") {
          this.setState("held");
          if (this.autoPlayOtherHand && this.handMode !== "both") {
            this.triggerCompanionAudio(step);
          }
          this.options.onChordHit?.(step);
        }

        // Determine which currently-held target keys must be released to advance:
        // Prefer pitches that end before/at the next step if any are currently held;
        // otherwise require releasing whichever active pitches of this step are currently held.
        const toRelease = this.getPitchesToReleaseForStep(step);
        const heldEnding = toRelease.filter((p) => this.heldUserPitches.has(p));
        this.waitReleasePitches.clear();
        if (heldEnding.length > 0) {
          for (const p of heldEnding) {
            this.waitReleasePitches.add(p);
          }
        } else {
          for (const p of step.activePitches) {
            if (this.heldUserPitches.has(p)) {
              this.waitReleasePitches.add(p);
            }
          }
        }
      }
    } else if (step.sustainedPitches.has(pitch) || this.isPitchSustainedInPiece(pitch, step.timeSeconds)) {
      // User is holding or re-striking an active sustained note from companion hand / score - valid
    } else {
      this.options.onWrongNote?.(pitch);
    }

    this.options.onStepChange?.(step, this.state);
  }

  public noteOff(pitch: number): void {
    this.heldUserPitches.delete(pitch);
    this.options.onStopNote?.(pitch, this.userVoiceId(pitch));

    const step = this.getCurrentStep();
    if (!step) return;

    // "Как только пользователь отпускает клавиши - руки и пальцы сдвигаются в новое положение и показывают новые клавиши"
    if (this.state === "held") {
      this.waitReleasePitches.delete(pitch);

      const anyActiveStillHeld = Array.from(step.activePitches).some((p) => this.heldUserPitches.has(p));
      if (this.waitReleasePitches.size === 0 || !anyActiveStillHeld) {
        this.waitReleasePitches.clear();
        this.advanceToNextStep();
        return; // Advance handled step change notification with nextStep
      }
    }

    this.options.onStepChange?.(step, this.state);
  }

  private getPitchesToReleaseForStep(step: PlayAlongStep): number[] {
    const nextIndex = this.getNextEligibleIndex(this.currentStepIndex);
    const nextStep = nextIndex === null ? undefined : this.steps[nextIndex];
    const endingPitches = step.notes
      .filter((n) => step.activePitches.has(n.pitch) && (!nextStep || n.endSeconds <= nextStep.timeSeconds + 0.1))
      .map((n) => n.pitch);
    return endingPitches.length > 0 ? endingPitches : Array.from(step.activePitches);
  }

  public seekToStep(index: number): void {
    this.cancelCompanionAudio();
    this.cancelTransition();
    this.completedPitchesInStep.clear();
    this.waitReleasePitches.clear();
    this.previousStepPitches.clear();

    const eligible = this.getEligibleStepIndices();
    if (eligible.length === 0) {
      this.currentStepIndex = -1;
      this.setState("completed");
      this.options.onStepChange?.(null, this.state);
      return;
    }

    const safeRequested = Math.max(0, Math.min(this.steps.length - 1, index));
    const requestedTime = this.steps[safeRequested]!.timeSeconds;
    const safeIndex = eligible.includes(safeRequested)
      ? safeRequested
      : eligible.reduce((nearest, candidate) =>
        Math.abs(this.steps[candidate]!.timeSeconds - requestedTime) <
          Math.abs(this.steps[nearest]!.timeSeconds - requestedTime)
          ? candidate
          : nearest,
      eligible[0]!);
    this.currentStepIndex = safeIndex;
    const step = this.steps[safeIndex]!;

    this.options.onTimeChange?.(step.timeSeconds);
    this.setState("waiting");
    this.options.onStepChange?.(step, this.state);
  }

  public nextStep(): void {
    const nextIndex = this.getNextEligibleIndex(this.currentStepIndex);
    if (nextIndex !== null) {
      this.seekToStep(nextIndex);
    } else {
      this.cancelCompanionAudio();
      this.setState("completed");
      this.options.onStepChange?.(null, this.state);
    }
  }

  public previousStep(): void {
    const previousIndex = this.getPreviousEligibleIndex(this.currentStepIndex);
    if (previousIndex !== null) this.seekToStep(previousIndex);
  }

  public restart(): void {
    this.seekToStep(0);
  }

  public completeTransitionInstantly(): void {
    if (this.state !== "transitioning") return;
    this.cancelTransition();
    const nextStep = this.getCurrentStep();
    if (nextStep) {
      this.options.onTimeChange?.(this.transitionToTime);
      this.setState("waiting");
      this.checkHeldKeysForNewStep(nextStep);
      this.options.onStepChange?.(nextStep, this.state);
    }
  }

  private advanceToNextStep(): void {
    this.cancelCompanionAudio();
    const nextIndex = this.getNextEligibleIndex(this.currentStepIndex);
    if (nextIndex === null) {
      this.setState("completed");
      this.options.onStepChange?.(null, this.state);
      return;
    }

    const currentStep = this.getCurrentStep();
    this.previousStepPitches = new Set(currentStep ? currentStep.targetPitches : []);
    this.waitReleasePitches.clear();

    const nextStep = this.steps[nextIndex]!;
    const fromTime = currentStep ? currentStep.timeSeconds : nextStep.timeSeconds;
    const toTime = nextStep.timeSeconds;

    if ((this.loopRange && toTime <= fromTime) || this.transitionDurationMs <= 0 || fromTime === toTime) {
      this.currentStepIndex = nextIndex;
      this.completedPitchesInStep.clear();
      this.options.onTimeChange?.(toTime);
      this.setState("waiting");
      this.checkHeldKeysForNewStep(nextStep);
      this.options.onStepChange?.(nextStep, this.state);
      return;
    }

    // Start smooth shift
    this.cancelTransition();
    this.setState("transitioning");
    this.currentStepIndex = nextIndex;
    this.completedPitchesInStep.clear();
    this.transitionFromTime = fromTime;
    this.transitionToTime = toTime;
    this.transitionStartTime = performance.now();

    // Immediately present the destination step in UI and keyboard glowing keys
    this.options.onStepChange?.(nextStep, this.state);

    const animate = (now: number) => {
      const elapsed = Math.max(0, now - this.transitionStartTime);
      const progress = Math.min(1, Math.max(0, elapsed / this.transitionDurationMs));
      // Ease in-out cubic
      const ease = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      const interpolatedTime = this.transitionFromTime + ease * (this.transitionToTime - this.transitionFromTime);

      this.options.onTimeChange?.(interpolatedTime);

      if (progress < 1) {
        this.transitionRaf = safeRaf(animate);
      } else {
        this.transitionRaf = null;
        this.options.onTimeChange?.(this.transitionToTime);
        this.setState("waiting");
        this.checkHeldKeysForNewStep(nextStep);
        this.options.onStepChange?.(nextStep, this.state);
      }
    };

    this.transitionRaf = safeRaf(animate);
  }

  private checkHeldKeysForNewStep(step: PlayAlongStep): void {
    // Only accept pitches currently held if they were NOT active/sustained in the previous step
    // (consecutive same notes require physical re-articulation / fresh strike).
    for (const p of step.activePitches) {
      if (this.heldUserPitches.has(p) && !this.previousStepPitches.has(p)) {
        this.completedPitchesInStep.add(p);
      }
    }
    const allSatisfied = Array.from(step.activePitches).every((p) => this.completedPitchesInStep.has(p));
    if (allSatisfied && step.activePitches.size > 0 && this.completedPitchesInStep.size > 0) {
      this.setState("held");
      if (this.autoPlayOtherHand && this.handMode !== "both") {
        this.triggerCompanionAudio(step);
      }
      this.options.onChordHit?.(step);
      this.waitReleasePitches.clear();
      for (const p of step.activePitches) {
        if (this.heldUserPitches.has(p)) {
          this.waitReleasePitches.add(p);
        }
      }
    }
  }

  private isPitchInNextStep(pitch: number): boolean {
    const nextIndex = this.getNextEligibleIndex(this.currentStepIndex);
    const nextStep = nextIndex === null ? undefined : this.steps[nextIndex];
    return nextStep ? nextStep.activePitches.has(pitch) : false;
  }

  private isPitchSustainedInPiece(pitch: number, timeSeconds: number): boolean {
    return this.allPlayableNotes.some((n) => {
      if (this.handMode === "right" && n.hand !== "right") return false;
      if (this.handMode === "left" && n.hand !== "left") return false;
      return n.pitch === pitch && n.startSeconds < timeSeconds - CLUSTER_WINDOW_SECONDS && n.endSeconds > timeSeconds + 0.05;
    });
  }

  private triggerCompanionAudio(step: PlayAlongStep): void {
    this.cancelCompanionAudio();
    const generation = this.companionGeneration;
    const nextIndex = this.getNextEligibleIndex(this.currentStepIndex);
    const nextStep = nextIndex === null || nextIndex <= this.currentStepIndex
      ? undefined
      : this.steps[nextIndex];
    const endTime = Math.min(
      nextStep ? nextStep.timeSeconds : step.timeSeconds + step.durationSeconds,
      this.loopRange?.endSeconds ?? Number.POSITIVE_INFINITY,
    );
    for (const n of this.allPlayableNotes) {
      const isOtherHand = this.handMode === "right" ? n.hand === "left" : n.hand === "right";
      if (!isOtherHand) continue;
      if (n.startSeconds >= step.timeSeconds - CLUSTER_WINDOW_SECONDS && n.startSeconds < endTime &&
          (!this.loopRange || n.startSeconds < this.loopRange.endSeconds)) {
        const delayMs = Math.max(0, n.startSeconds - step.timeSeconds) * 1000;
        const durMs = Math.min(2000, Math.max(250, (n.endSeconds - n.startSeconds) * 1000));
        const startVoice = () => {
          if (generation !== this.companionGeneration) return;

          const voiceId = `playalong-companion-${++this.companionVoiceSequence}`;
          const releaseTimer = setTimeout(() => this.releaseCompanionVoice(voiceId), durMs);
          this.activeCompanionVoices.set(voiceId, { pitch: n.pitch, releaseTimer });
          this.options.onPlayNote?.(n.pitch, 75, voiceId);
        };
        if (delayMs === 0) {
          startVoice();
        } else {
          const onsetTimer = setTimeout(() => {
            this.pendingCompanionTimers.delete(onsetTimer);
            startVoice();
          }, delayMs);
          this.pendingCompanionTimers.add(onsetTimer);
        }
      }
    }
  }

  private userVoiceId(pitch: number): string {
    // Keep the current user-note identity stable across engine recreation.
    return `playalong-${pitch}`;
  }

  private stopUserVoices(): void {
    for (const pitch of this.heldUserPitches) {
      this.options.onStopNote?.(pitch, this.userVoiceId(pitch));
    }
  }

  private releaseCompanionVoice(voiceId: string): void {
    const voice = this.activeCompanionVoices.get(voiceId);
    if (!voice) return;
    clearTimeout(voice.releaseTimer);
    this.activeCompanionVoices.delete(voiceId);
    this.options.onStopNote?.(voice.pitch, voiceId);
  }

  private cancelCompanionAudio(): void {
    this.companionGeneration += 1;
    for (const timer of this.pendingCompanionTimers) clearTimeout(timer);
    this.pendingCompanionTimers.clear();
    const activeVoices = Array.from(this.activeCompanionVoices.entries());
    this.activeCompanionVoices.clear();
    for (const [voiceId, voice] of activeVoices) {
      clearTimeout(voice.releaseTimer);
      this.options.onStopNote?.(voice.pitch, voiceId);
    }
  }

  private cancelTransition(): void {
    if (this.transitionRaf !== null) {
      safeCaf(this.transitionRaf);
      this.transitionRaf = null;
    }
  }

  private setState(next: PlayAlongState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }

  public dispose(): void {
    this.cancelCompanionAudio();
    this.cancelTransition();
    this.stopUserVoices();
    this.heldUserPitches.clear();
    this.completedPitchesInStep.clear();
    this.waitReleasePitches.clear();
    this.previousStepPitches.clear();
  }
}
