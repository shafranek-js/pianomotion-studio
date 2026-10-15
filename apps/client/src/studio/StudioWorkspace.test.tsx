import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

  it("shows editor actions and the preview anchor only in Fingering mode", () => {
    const tools = <button type="button">Assign finger</button>;
    const performance = renderToStaticMarkup(
      <StudioWorkspace viewMode="performance" scene={<canvas />} editorToolbar={tools} editorViewTime={3} />,
    );
    const fingering = renderToStaticMarkup(
      <StudioWorkspace viewMode="editor" scene={<canvas />} editorToolbar={tools} editorViewTime={3} transportTime={5} />,
    );

    expect(performance).toMatch(/studio-editor-toolbar[^>]*aria-hidden="true"[^>]*hidden=""/);
    expect(performance).toContain("Assign finger");
    expect(performance).not.toContain("studio-time-anchor");
    expect(fingering).toContain("studio-editor-toolbar");
    expect(fingering).toContain("View 0:03.0");
    expect(fingering).toContain("Playhead 0:05.0");
    expect(fingering).toContain('aria-label="Return to playhead"');
    expect(fingering).not.toContain("aria-live");
  });
});
