import { describe, expect, it } from "vitest";
import { isDebugGlobalsEnabled } from "./debugGlobals";

describe("CLI-12 debug globals gating", () => {
  it("enables debug globals only for dev builds or browser automation", () => {
    expect(isDebugGlobalsEnabled(true, false)).toBe(true);
    expect(isDebugGlobalsEnabled(false, true)).toBe(true);
    expect(isDebugGlobalsEnabled(false, false)).toBe(false);
    expect(isDebugGlobalsEnabled(false, undefined)).toBe(false);
  });
});
