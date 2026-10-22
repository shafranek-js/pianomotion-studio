import { describe, expect, it } from "vitest";
import { ProjectDeletionRegistry } from "./projectDeletionRegistry.ts";

describe("CLI-8 deletion/save ownership", () => {
  it("does not let a save started before deletion re-enable recovery", () => {
    const registry = new ProjectDeletionRegistry();
    const saveEpoch = registry.beginSave("project-a");

    registry.markDeleted("project-a");

    expect(registry.canReenable("project-a", saveEpoch)).toBe(false);
  });

  it("allows a deliberate save started after deletion", () => {
    const registry = new ProjectDeletionRegistry();
    registry.markDeleted("project-a");
    const saveEpoch = registry.beginSave("project-a");

    expect(registry.canReenable("project-a", saveEpoch)).toBe(true);
  });

  it("invalidates a save that crosses a second deletion", () => {
    const registry = new ProjectDeletionRegistry();
    registry.markDeleted("project-a");
    const saveEpoch = registry.beginSave("project-a");
    registry.markDeleted("project-a");

    expect(registry.canReenable("project-a", saveEpoch)).toBe(false);
  });
});
