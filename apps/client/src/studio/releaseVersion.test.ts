import { describe, expect, it } from "vitest";
import { formatStudioReleaseVersion } from "./releaseVersion";

describe("published studio release identity", () => {
  const buildId = "0123456789abcdef01234567";

  it("shows the package version plus a distinct build revision", () => {
    expect(formatStudioReleaseVersion("0.1.0-dev.23", buildId)).toBe("0.1.0-dev.23+01234567");
  });

  it("shows different versions when the production content changes", () => {
    expect(formatStudioReleaseVersion("0.1.0-dev.23", buildId))
      .not.toBe(formatStudioReleaseVersion("0.1.0-dev.23", "abcdef0123456789abcdef01"));
  });

  it("leaves a local development build without a fabricated release revision", () => {
    expect(formatStudioReleaseVersion("0.1.0-dev.23", "development")).toBe("0.1.0-dev.23");
    expect(formatStudioReleaseVersion("0.1.0-dev.23", "")).toBe("0.1.0-dev.23");
  });

  it("rejects malformed or truncated build IDs", () => {
    expect(formatStudioReleaseVersion("0.1.0-dev.23", "abcdef")).toBe("0.1.0-dev.23");
    expect(formatStudioReleaseVersion("0.1.0-dev.23", "z".repeat(24))).toBe("0.1.0-dev.23");
  });
});
