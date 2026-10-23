import { isRetryableFailure } from "../vendor/openviking-memory-plugin-shared/lib/retryable.mjs";

export function classifyOpenVikingFailure(result) {
  if (!result || typeof result !== "object") {
    return { category: "retryable", status: null, retryable: true };
  }
  if (result.ok === true) {
    return { category: "accepted", status: Number(result.status) || null, retryable: false };
  }
  const status = Number(result.status) || null;
  if (status === 401 || status === 403) {
    return { category: "authentication", status, retryable: false };
  }
  if (isRetryableFailure(result)) {
    return { category: "retryable", status, retryable: true };
  }
  return { category: "terminal", status, retryable: false };
}
