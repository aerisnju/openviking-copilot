import assert from "node:assert/strict";
import test from "node:test";
import { verifyVendoredIntegrity } from "../src/vendor-status.mjs";

// The vendored tree is a fixed upstream snapshot. Its manifest exists so that a
// hand edit is caught here instead of being silently discarded by the next
// refresh, and so a refresh cannot pass unnoticed.
test("vendored files still match their recorded digests", async () => {
  const report = await verifyVendoredIntegrity();
  assert.equal(report.ok, true, `integrity problems: ${JSON.stringify(report.problems)}`);
  assert.match(report.commit, /^[0-9a-f]{40}$/);
});

test("the manifest pins a commit and lists every vendored file", async () => {
  const report = await verifyVendoredIntegrity();
  assert.equal(typeof report.commit, "string");
  assert.equal(report.problems.length, 0);
});