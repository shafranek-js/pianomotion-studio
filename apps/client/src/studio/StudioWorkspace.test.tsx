import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioShell } from "./StudioShell";
import { StudioWorkspace } from "./StudioWorkspace";

describe("StudioWorkspace", () => {
  it("uses one persistent scene surface in both supported modes", () => {
    for (const viewMode of ["performance", "editor"] as const) {
      const markup = renderToStaticMarkup(
        <StudioWorkspace viewMode={viewMode} scene={<canvas aria-label="Piano scene" />} />,
      );

      expect(markup).toContain('data-testid="studio-workspace"');
      expect(markup).toContain('data-testid="studio-scene-pane"');
      expect(markup).toContain('data-view="' + viewMode + '"');
      expect(markup).toContain('aria-label="Piano scene"');
      expect(markup).not.toContain("separator");
      expect(markup).not.toContain("piano-roll-viewport");
    }
  });

  it("keeps editor state mounted headlessly while the scene occupies the workspace", () => {
    const editorState = <button type="button">Assign finger</button>;
    const performance = renderToStaticMarkup(
      <StudioWorkspace viewMode="performance" scene={<canvas />} editorState={editorState} editorViewTime={3} />,
    );
    const fingering = renderToStaticMarkup(
      <StudioWorkspace viewMode="editor" scene={<canvas />} editorState={editorState} editorViewTime={3} transportTime={5} />,
    );

    expect(performance).toContain('data-testid="studio-editor-state"');
    expect(fingering).toContain('data-testid="studio-editor-state"');
    expect(performance).toContain("Assign finger");
    expect(fingering).toContain("Assign finger");
    expect(performance).toContain('aria-hidden="true" hidden=""');
    expect(fingering).toContain('aria-hidden="true" hidden=""');
    expect(performance).not.toContain("studio-editor-toolbar");
    expect(fingering).not.toContain("studio-editor-toolbar");
    expect(performance).not.toContain("studio-time-anchor");
    expect(fingering).toContain("View 0:03.0");
    expect(fingering).toContain("Playhead 0:05.0");
    expect(fingering).toContain('aria-label="Return to playhead"');
    expect(fingering).not.toContain("aria-live");
  });

  it("renders 2D/3D toggle and 3D camera presets in performance and play_along modes", () => {
    const noop = () => {};
    const hud3d = renderToStaticMarkup(
      <StudioWorkspace
        viewMode="performance"
        scene={<canvas />}
        is3DView
        onToggle3DView={noop}
        camera3DPreset="concert"
        onCamera3DPresetChange={noop}
      />,
    );

    expect(hud3d).toContain('data-testid="studio-camera-hud"');
    expect(hud3d).toContain("Concert");
    expect(hud3d).toContain("Overhead");
    expect(hud3d).toContain("Pianist POV");
    expect(hud3d).toContain("Side Arch");
    expect(hud3d).toContain('aria-label="3D camera preset"');
    expect(hud3d).toContain('<option value="concert" selected="">Concert</option>');

    const editorHud = renderToStaticMarkup(
      <StudioWorkspace
        viewMode="editor"
        scene={<canvas />}
        is3DView
        onToggle3DView={noop}
        camera3DPreset="concert"
        onCamera3DPresetChange={noop}
      />,
    );
    expect(editorHud).not.toContain('data-testid="studio-camera-hud"');

    // When showCameraHud is false, the floating canvas overlay is omitted
    const hiddenHud = renderToStaticMarkup(
      <StudioWorkspace
        viewMode="performance"
        scene={<canvas />}
        is3DView
        onToggle3DView={noop}
        camera3DPreset="concert"
        onCamera3DPresetChange={noop}
        showCameraHud={false}
      />,
    );
    expect(hiddenHud).not.toContain('data-testid="studio-camera-hud"');
  });

  it("renders 2D/3D toggle and 3D camera presets on StudioShell top header bar", () => {
    const noop = () => {};
    const shellMarkup = renderToStaticMarkup(
      <StudioShell
        projectName="Test Song"
        hasProject
        viewMode="performance"
        onViewModeChange={noop}
        is3DView
        onToggle3DView={noop}
        camera3DPreset="side_arch"
        onCamera3DPresetChange={noop}
        status={{ kind: "saved", message: "Saved" }}
        onOpenMidi={noop}
        onOpenPackage={noop}
        projectsPanel={<div />}
        inspector={<div />}
        workspace={<div />}
      />,
    );

    expect(shellMarkup).toContain('data-testid="studio-header-camera-hud"');
    expect(shellMarkup).toContain("Concert");
    expect(shellMarkup).toContain("Overhead");
    expect(shellMarkup).toContain("Pianist POV");
    expect(shellMarkup).toContain("Side Arch");
    expect(shellMarkup).toContain("2D");
    expect(shellMarkup).toContain("3D");
    expect(shellMarkup).toContain('aria-label="3D camera preset"');
    expect(shellMarkup).toContain('<option value="side_arch" selected="">Side Arch</option>');
  });
});

