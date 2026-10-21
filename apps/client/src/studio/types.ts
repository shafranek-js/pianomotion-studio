import type { ReactNode } from "react";
import type { Camera3DPreset } from "../render";

export type StudioView = "performance" | "play_along" | "editor";

export function normalizeStudioView(value: unknown): StudioView {
  if (value === "editor") return "editor";
  if (value === "play_along") return "play_along";
  return "performance";
}

export type InspectorTab = "scene" | "pianist" | "audio" | "diagnostics";

export interface StudioStatus {
  kind: "idle" | "loading" | "calculating" | "saving" | "saved" | "modified" | "warning" | "error";
  message: string;
  progress?: number;
  details?: string;
}

export interface StudioLayoutPreferences {
  activePanel: "projects" | "inspector" | "practice" | null;
  pinnedSide: "left" | "right" | null;
  leftWidth: number;
  rightWidth: number;
  /** Retained to read older layout records; the unified workspace no longer uses split view. */
  splitRatio: number;
  inspectorTab: InspectorTab;
  focusMode: boolean;
}

export interface StudioWorkspaceLayout {
  effectiveView: StudioView;
  focusMode: boolean;
}

export interface StudioEditActions {
  canUndo: boolean;
  canRedo: boolean;
  undo(): void;
  redo(): void;
}

export const CAMERA_PRESETS: Array<{
  id: Camera3DPreset;
  label: string;
  shortLabel: string;
  title: string;
}> = [
  { id: "concert", label: "Concert", shortLabel: "Concert", title: "3/4 concert angle (~50° side view)" },
  { id: "overhead", label: "Overhead", shortLabel: "Overhead", title: "Top-down perspective over the 88 keys" },
  { id: "pov", label: "Pianist POV", shortLabel: "POV", title: "First-person perspective from behind the hands" },
  { id: "side_arch", label: "Side Arch", shortLabel: "Side", title: "Close-up side profile of hand arch and knuckles" },
];

export interface StudioShellProps {
  projectName: string;
  hasProject: boolean;
  viewMode: StudioView;
  onViewModeChange: (view: StudioView) => void;
  is3DView?: boolean;
  onToggle3DView?: (enabled: boolean) => void;
  camera3DPreset?: Camera3DPreset;
  onCamera3DPresetChange?: (preset: Camera3DPreset) => void;
  status: StudioStatus;
  busy?: boolean;
  onOpenMidi: () => void;
  onOpenBuiltinMelodies?: () => void;
  onOpenPackage: () => void;
  onSave?: () => void;
  onExportMidi?: () => void;
  onExportPackage?: () => void;
  onExportVideo?: () => void;
  videoExportUnavailableReason?: string;
  canSave?: boolean;
  canExport?: boolean;
  onOpenPreferences?: () => void;
  onOpenPianist?: () => void;
  editActions?: StudioEditActions;
  projectsPanel: ReactNode;
  inspector: ReactNode | ((tab: InspectorTab) => ReactNode);
  practicePanel?: ReactNode;
  workspace: ReactNode | ((layout: StudioWorkspaceLayout) => ReactNode);
  transport?: ReactNode;
  footerAddon?: ReactNode;
  dialogs?: ReactNode;
  headerAddon?: ReactNode;
}
