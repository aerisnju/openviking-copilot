import { isRetryableFailure } from "../vendor/openviking-memory-plugin-shared/lib/retryable.mjs";

/**
 * Tell a credential 403 apart from a content 403.
 *
 * The server returns 403 for two unrelated reasons: the API key lacks
 * permission, or the payload itself was rejected — for example a tool argument
 * containing shell command substitution (`` `date` ``), which the server treats
 * as an injection risk. Only the first is an authentication problem. Classifying
 * both as `authentication` sends the operator to rotate credentials that are
 * fine, and hides the real cause behind a dead letter.
 *
 * A credential failure carries an auth-shaped message; anything else at 403 is
 * treated as content rejection, which is terminal for that record but not a
 * reason to stop retrying unrelated work.
 */
function looksLikeAuthenticationFailure(result) {
  const message = String(
    result?.error?.message
      ?? result?.error?.code
      ?? result?.error?.type
      ?? "",
  ).toLowerCase();
  if (!message) return false;
  return /unauthor|authentic|forbidden|permission|api[ _-]?key|token|credential|scope|rbac|not allowed/.test(message);
}

export function classifyOpenVikingFailure(result) {
  if (!result || typeof result !== "object") {
    return { category: "retryable", status: null, retryable: true };
  }
  if (result.ok === true) {
    return { category: "accepted", status: Number(result.status) || null, retryable: false };
  }
  const status = Number(result.status) || null;
  if (status === 401) {
    return { category: "authentication", status, retryable: false };
  }
  if (status === 403) {
    return looksLikeAuthenticationFailure(result)
      ? { category: "authentication", status, retryable: false }
      : { category: "rejected-content", status, retryable: false };
  }
  if (isRetryableFailure(result)) {
    return { category: "retryable", status, retryable: true };
  }
  return { category: "terminal", status, retryable: false };
}
