import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioShell } from "./StudioShell";
import type { StudioShellProps } from "./types";

function renderShell(overrides: Partial<StudioShellProps> = {}) {
  const noop = () => {};
  return renderToStaticMarkup(<StudioShell
    projectName="Practice song"
    hasProject
    viewMode="performance"
    onViewModeChange={noop}
    status={{ kind: "saved", message: "Saved" }}
    onOpenMidi={noop}
    onOpenBuiltinMelodies={noop}
    onOpenPackage={noop}
    onOpenPianist={noop}
    onOpenPreferences={noop}
    projectsPanel={<div>Saved projects</div>}
    inspector={<div>Scene settings</div>}
    practicePanel={<div>Practice settings</div>}
    workspace={<canvas aria-label="Piano scene" />}
    {...overrides}
  />);
}

describe("StudioShell Focus entry and navigation", () => {
  it("groups workspace destinations and project settings in the rail with import available through File", () => {
    const markup = renderShell();
    const rail = markup.slice(markup.indexOf('class="studio-tool-rail"'), markup.indexOf("<main"));
    expect((rail.match(/<button /g) ?? [])).toHaveLength(8);
    const header = markup.slice(markup.indexOf("<header"), markup.indexOf("</header>"));
    for (const label of ["Export", "Open pianist settings", "Open preferences"]) {
      expect(rail).toContain(`aria-label="${label}"`);
      expect(header).not.toContain(`aria-label="${label}"`);
    }
    expect(rail).toContain('aria-label="Project and app settings"');
    expect(rail).toContain('aria-haspopup="menu" aria-expanded="false"');
    expect(rail).toContain("Browse melody library");
    expect(rail).toContain('aria-label="Projects"');
    expect(rail).toContain('aria-label="Inspector"');
    expect(rail).toContain('aria-label="Practice"');
    expect(rail).toContain('class="studio-focus-toggle"');
    expect(rail).not.toContain("Open MIDI");
    expect(rail).not.toContain("Audio recording");
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('class="studio-header-button studio-menu-trigger');
  });

  it("explains unavailable Focus and leaves the workspace keyboard focus target mounted", () => {
    const markup = renderShell({
      focusModeDisabled: true,
      focusModeDisabledReason: "Finish the pose edit before entering Focus.",
    });
    expect(markup).toMatch(/class="studio-focus-toggle" disabled=""[^>]*title="Finish the pose edit before entering Focus\."/);
    expect(markup).toContain('tabindex="-1" data-testid="studio-workspace-focus-target"');
    expect(markup).toContain('aria-label="Piano scene"');
    expect(markup).toContain('data-focus-mode="off"');
  });
});
