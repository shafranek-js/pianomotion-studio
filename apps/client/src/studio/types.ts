import type { ReactNode } from "react";

export type StudioView = "performance" | "editor";

/** Maps previously saved three-view state onto the supported two-view workspace. */
export function normalizeStudioView(value: unknown): StudioView {
  return value === "editor" ? "editor" : "performance";
}

export type InspectorTab = "scene" | "pianist" | "audio" | "diagnostics";

export interface StudioStatus {
  kind: "idle" | "loading" | "calculating" | "saving" | "saved" | "modified" | "error";
  message: string;
  progress?: number;
  details?: string;
}

export interface StudioLayoutPreferences {
  activePanel: "projects" | "inspector" | null;
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

export interface StudioShellProps {
  projectName: string;
  hasProject: boolean;
  viewMode: StudioView;
  onViewModeChange: (view: StudioView) => void;
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
  workspace: ReactNode | ((layout: StudioWorkspaceLayout) => ReactNode);
  transport?: ReactNode;
  footerAddon?: ReactNode;
  dialogs?: ReactNode;
  headerAddon?: ReactNode;
}
