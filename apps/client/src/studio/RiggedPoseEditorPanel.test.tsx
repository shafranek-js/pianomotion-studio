import { createElement, isValidElement, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RiggedPoseEditorPanel, type RiggedPoseEditorPanelProps } from "./RiggedPoseEditorPanel";

function makeProps(selectedBoneName: string | null): RiggedPoseEditorPanelProps {
  return {
    active: true,
    canEnter: true,
    is3DMode: true,
    modelMatches: true,
    busy: false,
    timepoints: [{
      id: "sample:1",
      kind: "sampled",
      displayedTransportTimeSeconds: 1,
      sourcePoseTimeSeconds: 1,
    }],
    availabilityById: {
      "sample:1": { available: true, leftAvailable: true, rightAvailable: true, reason: null },
    },
    selectedTimepointId: "sample:1",
    selectedSide: "right",
    selectedBoneName,
    fingerFilter: "all",
    transformMode: "rotate",
    undoAvailable: false,
    draftCount: 0,
    sampleSources: {
      left: { sampleMode: "exact", sourcePoseTimeSeconds: 1, sourcePoseTimeStartSeconds: 1, sourcePoseTimeEndSeconds: 1 },
      right: { sampleMode: "exact", sourcePoseTimeSeconds: 1, sourcePoseTimeStartSeconds: 1, sourcePoseTimeEndSeconds: 1 },
    },
    sourceHashesVerified: false,
    presets: [],
    selectedPresetId: "",
    presetName: "",
    renamePresetName: "",
    status: null,
    error: null,
    onEnter: vi.fn(),
    onCancel: vi.fn(),
    onSeek: vi.fn(),
    onSideChange: vi.fn(),
    onSelectWholeHand: vi.fn(),
    onFingerFilterChange: vi.fn(),
    onTransformModeChange: vi.fn(),
    onUndo: vi.fn(),
    onReset: vi.fn(),
    onPresetNameChange: vi.fn(),
    onPresetChange: vi.fn(),
    onSavePreset: vi.fn(),
    onApplyPreset: vi.fn(),
    onExportPreset: vi.fn(),
    onImportPresetFile: vi.fn(async () => {}),
    onRenamePresetNameChange: vi.fn(),
    onRenamePreset: vi.fn(),
    onReplacePreset: vi.fn(),
    onDeletePreset: vi.fn(),
  };
}

describe("RiggedPoseEditorPanel selected target", () => {
  it("offers a same-hand return to the whole hand after selecting a bone", () => {
    const props = makeProps("right_ring_metacarpal");
    const markup = renderToStaticMarkup(createElement(RiggedPoseEditorPanel, props));

    expect(markup).toContain("right_ring_metacarpal");
    expect(markup).toContain('>Select whole hand</button>');

    const button = findButton(RiggedPoseEditorPanel(props), "Select whole hand");
    expect(button).not.toBeNull();
    button!.props.onClick?.();
    expect(props.onSelectWholeHand).toHaveBeenCalledOnce();
  });

  it("does not show the return action while the whole hand is already selected", () => {
    const markup = renderToStaticMarkup(createElement(RiggedPoseEditorPanel, makeProps(null)));

    expect(markup).toContain("right hand");
    expect(markup).not.toContain("Select whole hand");
  });

  it("exports the selected saved pose preset when requested", () => {
    const props = makeProps(null);
    props.presets = [{ presetId: "preset-start", name: "Starting pose", createdAtUnixMs: 1 }];
    props.selectedPresetId = "preset-start";

    const button = findButton(RiggedPoseEditorPanel(props), "Download preset as JSON");
    expect(button).not.toBeNull();
    expect(button!.props.disabled).toBe(false);

    button!.props.onClick?.();
    expect(props.onExportPreset).toHaveBeenCalledOnce();
  });

  it("disables preset export while the editor is busy", () => {
    const props = makeProps(null);
    props.busy = true;
    props.presets = [{ presetId: "preset-start", name: "Starting pose", createdAtUnixMs: 1 }];
    props.selectedPresetId = "preset-start";

    const button = findButton(RiggedPoseEditorPanel(props), "Download preset as JSON");
    expect(button).not.toBeNull();
    expect(button!.props.disabled).toBe(true);
  });

  it("requires explicit confirmation before replacing the named preset and honors cancellation", () => {
    const props = makeProps(null);
    props.presets = [{ presetId: "pose-start-123456", name: "Starting pose", createdAtUnixMs: 1 }];
    props.selectedPresetId = "pose-start-123456";
    const confirmMessages: string[] = [];
    const confirm = vi.fn((message: string) => {
      confirmMessages.push(message);
      return false;
    });
    vi.stubGlobal("window", { confirm });
    try {
      const button = findButton(RiggedPoseEditorPanel(props), "Update selected preset from current pose");
      expect(button).not.toBeNull();
      button!.props.onClick?.();

      expect(confirm).toHaveBeenCalledOnce();
      expect(confirmMessages[0]).toContain("Starting pose");
      expect(confirmMessages[0]).toContain("pose-start-123456");
      expect(props.onReplacePreset).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires confirmation before deleting the named preset and honors cancellation", () => {
    const props = makeProps(null);
    props.presets = [{ presetId: "pose-delete-987654", name: "Legacy pose", createdAtUnixMs: 1 }];
    props.selectedPresetId = "pose-delete-987654";
    const confirmMessages: string[] = [];
    const confirm = vi.fn((message: string) => {
      confirmMessages.push(message);
      return false;
    });
    vi.stubGlobal("window", { confirm });
    try {
      const button = findButton(RiggedPoseEditorPanel(props), "Delete selected preset");
      expect(button).not.toBeNull();
      button!.props.onClick?.();

      expect(confirm).toHaveBeenCalledOnce();
      expect(confirmMessages[0]).toContain("Legacy pose");
      expect(confirmMessages[0]).toContain("pose-delete-987654");
      expect(props.onDeletePreset).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps rename as a separate action for the selected saved preset", () => {
    const props = makeProps(null);
    props.presets = [{ presetId: "pose-rename-123", name: "Original pose", createdAtUnixMs: 1 }];
    props.selectedPresetId = "pose-rename-123";
    props.renamePresetName = "Renamed pose";
    const panel = RiggedPoseEditorPanel(props);
    const button = findButton(panel, "Rename selected preset");

    expect(renderToStaticMarkup(createElement(RiggedPoseEditorPanel, props))).toContain("Selected saved preset");
    expect(button).not.toBeNull();
    expect(button!.props.disabled).toBe(false);
    button!.props.onClick?.();
    expect(props.onRenamePreset).toHaveBeenCalledOnce();
    expect(props.onApplyPreset).not.toHaveBeenCalled();
    expect(props.onReplacePreset).not.toHaveBeenCalled();
  });

  it("distinguishes normalized-name legacy duplicates by date and unique ID prefix", () => {
    const props = makeProps(null);
    const timestamp = 1_700_000_000_000;
    props.presets = [
      { presetId: "dupeA-001", name: "Café", createdAtUnixMs: timestamp },
      { presetId: "dupeB-001", name: "Cafe\u0301", createdAtUnixMs: timestamp },
    ];
    props.selectedPresetId = "dupeA-001";
    const markup = renderToStaticMarkup(createElement(RiggedPoseEditorPanel, props));
    const dateLabel = new Date(timestamp).toLocaleString();

    expect(markup).toContain(`Café · ${dateLabel} · dupeA-00`);
    expect(markup).toContain(`Cafe\u0301 · ${dateLabel} · dupeB-00`);
  });

  it("clears the file input so the same preset JSON can be selected again", () => {
    const props = makeProps(null);
    props.sourceHashesVerified = true;
    const file = { name: "starting-pose.json", size: 32 } as File;
    const input = findFileInput(RiggedPoseEditorPanel(props));
    expect(input).not.toBeNull();
    const currentTarget = { files: [file], value: "starting-pose.json" } as unknown as HTMLInputElement;

    input!.props.onChange?.({ currentTarget } as ChangeEvent<HTMLInputElement>);
    expect(currentTarget.value).toBe("");
    currentTarget.value = "starting-pose.json";
    input!.props.onChange?.({ currentTarget } as ChangeEvent<HTMLInputElement>);

    expect(currentTarget.value).toBe("");
    expect(props.onImportPresetFile).toHaveBeenCalledTimes(2);
    expect(props.onImportPresetFile).toHaveBeenNthCalledWith(1, file);
    expect(props.onImportPresetFile).toHaveBeenNthCalledWith(2, file);
  });
});

function findButton(node: ReactNode, label: string): ReactElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findButton(child, label);
      if (match) return match;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>(node)) return null;
  if (node.type === "button" && renderText(node.props.children) === label) return node;
  return findButton(node.props.children, label);
}

function findFileInput(node: ReactNode): ReactElement<{ children?: ReactNode; type?: string; onChange?: (event: ChangeEvent<HTMLInputElement>) => void }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findFileInput(child);
      if (match) return match;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; type?: string; onChange?: (event: ChangeEvent<HTMLInputElement>) => void }>(node)) return null;
  if (node.type === "input" && node.props.type === "file") return node;
  return findFileInput(node.props.children);
}

function renderText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return renderText(node.props.children);
  return "";
}
