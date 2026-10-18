import type {
  FingeringPlan,
  M1AnalyzeMidiResult,
  M1KeyStyle,
  PianistProfile,
  ProjectSourceContext,
  SongDocument,
  PracticeState,
} from "@handthesia/contracts";
import type { Camera3DPreset } from "../render";
import type { SessionSnapshot } from "../storage";
import type { StudioView } from "../studio/types";

export interface RecoverySnapshotInput {
  projectName: string;
  updatedAt: number;
  document: SongDocument;
  draftFingeringPlan: FingeringPlan;
  result: M1AnalyzeMidiResult;
  rawMidiBytes: ArrayBuffer;
  profile: PianistProfile;
  keyStyle: M1KeyStyle;
  sourceContext: ProjectSourceContext;
  viewMode: StudioView;
  sceneView: { dimension: "2d" | "3d"; cameraPreset: Camera3DPreset };
  plansState: "valid" | "recompute-required";
  practiceState?: PracticeState;
}

/** Builds the same complete recovery record for debounced autosave and explicit Save. */
export function buildRecoverySnapshot(input: RecoverySnapshotInput): SessionSnapshot {
  return {
    projectId: input.result.projectId,
    projectName: input.projectName,
    updatedAt: input.updatedAt,
    document: input.document,
    fingeringPlan: input.draftFingeringPlan,
    draftFingeringPlan: input.draftFingeringPlan,
    result: input.result,
    rawMidiBytes: input.rawMidiBytes,
    activeProfileId: input.profile.profileId,
    profile: input.profile,
    plansState: input.plansState,
    keyStyle: input.keyStyle,
    sourceContext: input.sourceContext,
    sourceDescriptor: input.result.resource,
    viewMode: input.viewMode,
    sceneView: input.sceneView,
    ...(input.practiceState ? { practiceState: input.practiceState } : {}),
  };
}
