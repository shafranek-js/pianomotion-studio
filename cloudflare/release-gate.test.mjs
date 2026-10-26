import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assertApprovedCloudflareRelease } from "./release-gate.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("Cloudflare deploy stays blocked without a pinned approved SHA", () => {
  for (const value of [undefined, "", "main", "latest", "a".repeat(39), "A".repeat(40)]) {
    assert.throws(() => assertApprovedCloudflareRelease(value, A), /blocked/);
  }
});

test("Cloudflare deploy stays blocked for a different commit, even with prior approval", () => {
  assert.throws(() => assertApprovedCloudflareRelease(A, B), /differs/);
  assert.throws(() => assertApprovedCloudflareRelease(A, "not-a-commit"), /blocked/);
});

test("Cloudflare deploy can proceed only on the exact explicitly approved full SHA", () => {
  assert.equal(assertApprovedCloudflareRelease(A, A), true);
});
