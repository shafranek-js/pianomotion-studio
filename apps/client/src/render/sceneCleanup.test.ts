import { describe, expect, it, vi } from "vitest";
import { disposeFailedScene } from "./pianoScene";

describe("CLI-4 scene initialization cleanup", () => {
  it("destroys the partially initialized Application when no scene was constructed", () => {
    const app = { destroy: vi.fn() };
    disposeFailedScene(app as never, null);

    expect(app.destroy).toHaveBeenCalledWith(true, { children: true });
  });

  it("destroys a constructed scene instead of double-destroying its Application", () => {
    const app = { destroy: vi.fn() };
    const scene = { destroy: vi.fn() };
    disposeFailedScene(app as never, scene as never);

    expect(scene.destroy).toHaveBeenCalledTimes(1);
    expect(app.destroy).not.toHaveBeenCalled();
  });

  it("does not mask the original error when Application cleanup itself throws", () => {
    const app = { destroy: vi.fn(() => { throw new Error("cleanup failed"); }) };
    expect(() => disposeFailedScene(app as never, null)).not.toThrow();
  });

  it("does not mask the original error when scene cleanup itself throws", () => {
    const scene = { destroy: vi.fn(() => { throw new Error("scene cleanup failed"); }) };
    expect(() => disposeFailedScene({ destroy: vi.fn() } as never, scene as never)).not.toThrow();
  });
});
