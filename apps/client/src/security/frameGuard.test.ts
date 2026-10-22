import { describe, expect, it } from "vitest";
import { isFramed } from "./frameGuard";

describe("DEP-2 frame guard", () => {
  it("runs only as the top-level document", () => {
    const self = {};
    expect(isFramed(self, self)).toBe(false);
    expect(isFramed({}, self)).toBe(true);
    expect(isFramed(null, self)).toBe(true);
  });
});
