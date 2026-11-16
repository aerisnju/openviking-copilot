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

test("separates a credential 403 from a content 403", () => {
  // A credential failure names the auth problem.
  assert.deepEqual(
    classifyOpenVikingFailure({ ok: false, status: 403, error: { message: "unauthorized: invalid api key" } }),
    { category: "authentication", status: 403, retryable: false },
  );
  assert.deepEqual(
    classifyOpenVikingFailure({ ok: false, status: 403, error: { code: "FORBIDDEN_SCOPE" } }),
    { category: "authentication", status: 403, retryable: false },
  );
  // A content rejection does not, so the operator is not sent to rotate a key
  // that is fine.
  assert.deepEqual(
    classifyOpenVikingFailure({ ok: false, status: 403, error: { message: "HTTP 403" } }),
    { category: "rejected-content", status: 403, retryable: false },
  );
  assert.deepEqual(
    classifyOpenVikingFailure({ ok: false, status: 403 }),
    { category: "rejected-content", status: 403, retryable: false },
  );
});

test("keeps 401 as authentication regardless of message", () => {
  assert.deepEqual(
    classifyOpenVikingFailure({ ok: false, status: 401, error: { message: "HTTP 401" } }),
    { category: "authentication", status: 401, retryable: false },
  );
});
