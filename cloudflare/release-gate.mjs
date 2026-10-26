/**
 * Safety gate for Git-connected Cloudflare Workers Builds.
 *
 * A push to main must NEVER implicitly publish the incomplete Testing hand.
 * Only an exact explicitly approved commit SHA may reach wrangler deploy.
 * Pure comparison function is exported to unit-test fail-closed behavior.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;

export function assertApprovedCloudflareRelease(approved, actual) {
  if (typeof approved !== "string" || !FULL_COMMIT_SHA.test(approved)) {
    throw new Error("Cloudflare publication blocked: set PIANOMOTION_CLOUDFLARE_RELEASE_SHA to the exact 40-character approved Git commit.");
  }
  if (typeof actual !== "string" || !FULL_COMMIT_SHA.test(actual)) {
    throw new Error("Cloudflare publication blocked: cannot prove the checked-out Git commit.");
  }
  if (approved !== actual) {
    throw new Error(`Cloudflare publication blocked: checked-out commit ${actual} differs from approved ${approved}.`);
  }
  return true;
}

export function requireApprovedCloudflareRelease() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  }).trim();
  assertApprovedCloudflareRelease(process.env.PIANOMOTION_CLOUDFLARE_RELEASE_SHA, sha);
  console.log("Cloudflare release approval confirmed for commit " + sha);
}
