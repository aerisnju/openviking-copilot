import assert from "node:assert/strict";
import test from "node:test";
import { classifyOpenVikingFailure } from "../src/retry-policy.mjs";

test("classifies transient, authentication, terminal, and accepted outcomes", () => {
  assert.deepEqual(classifyOpenVikingFailure({ status: 503 }), {
    category: "retryable",
    status: 503,
    retryable: true,
  });
  assert.equal(classifyOpenVikingFailure({ status: 429 }).retryable, true);
  assert.deepEqual(classifyOpenVikingFailure({ status: 401 }), {
    category: "authentication",
    status: 401,
    retryable: false,
  });
  assert.equal(classifyOpenVikingFailure({ status: 422 }).category, "terminal");
  assert.equal(
    classifyOpenVikingFailure({
      status: 409,
      error: { details: { retryable: true } },
    }).retryable,
    true,
  );
  assert.equal(classifyOpenVikingFailure({ ok: true, status: 200 }).category, "accepted");
  assert.equal(classifyOpenVikingFailure(new Error("connection reset")).retryable, true);
});
