import { describe, expect, it } from "vitest";
import {
  chooseImprovedHandExportLod,
  chooseImprovedHandLod,
  HandModelRequestGate,
  errorMessage,
} from "./improvedHandRuntime";

describe("improved hand runtime primitives", () => {
  it("selects projected-size LODs with hysteresis at tier boundaries", () => {
    expect(chooseImprovedHandLod(500)).toBe(0);
    expect(chooseImprovedHandLod(300)).toBe(1);
    expect(chooseImprovedHandLod(100)).toBe(2);

    expect(chooseImprovedHandLod(360, 0)).toBe(0);
    expect(chooseImprovedHandLod(340, 0)).toBe(1);
    expect(chooseImprovedHandLod(150, 1)).toBe(1);
    expect(chooseImprovedHandLod(130, 1)).toBe(2);
    expect(chooseImprovedHandLod(190, 2)).toBe(2);
    expect(chooseImprovedHandLod(210, 2)).toBe(1);
  });

  it("keeps fixed viewport exports on a deterministic highest-detail tier", () => {
    expect(chooseImprovedHandExportLod()).toBe(0);
  });

  it("rejects stale async completions after a new request or disposal", () => {
    const gate = new HandModelRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.dispose();
    expect(gate.isCurrent(second)).toBe(false);
    expect(gate.begin()).toBe(-1);
  });

  it("exposes useful load failure text", () => {
    expect(errorMessage(new Error("missing improved LOD"))).toBe("missing improved LOD");
    expect(errorMessage({})).toBe("Improved hand assets could not be loaded.");
  });
});
