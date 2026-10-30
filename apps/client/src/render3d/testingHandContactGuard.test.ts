import { describe, expect, it } from "vitest";
import { permitsTestingContactCandidate } from "./testingHandContactGuard";

describe("Testing contact candidate pad clearance", () => {
  it("rejects newly introduced penetration in a different sampled pad point", () => {
    expect(permitsTestingContactCandidate(0.4, -0.09)).toBe(false);
    expect(permitsTestingContactCandidate(0.4, -0.019)).toBe(true);
  });
  it("permits improvement of existing penetration but not making it worse", () => {
    expect(permitsTestingContactCandidate(-0.12, -0.07)).toBe(true);
    expect(permitsTestingContactCandidate(-0.12, -0.13)).toBe(false);
  });
  it("does not treat unavailable or invalid measurements as contact", () => {
    expect(permitsTestingContactCandidate(null, null)).toBe(false);
    expect(permitsTestingContactCandidate(null, -0.09)).toBe(false);
    expect(permitsTestingContactCandidate(null, 0.01)).toBe(true);
    expect(permitsTestingContactCandidate(0, Number.NaN)).toBe(false);
  });
});
