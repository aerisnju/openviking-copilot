import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildPluginConfig } from "../vendor/openviking-memory-plugin-shared/lib/plugin-config.mjs";
import { loadCredentialFiles } from "../vendor/openviking-memory-plugin-shared/lib/credentials.mjs";
import { describeInputFilters } from "../vendor/openviking-memory-plugin-shared/lib/input-filters.mjs";

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  return isIP(host) === 4 && host.split(".")[0] === "127";
}

function summarizeEndpoint(value) {
  if (!value) {
    return {
      display: "(not configured)",
      valid: false,
      secure: false,
      loopback: false,
      reason: "missing",
    };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return {
      display: "(invalid URL)",
      valid: false,
      secure: false,
      loopback: false,
      reason: "invalid",
    };
  }
  const loopback = isLoopback(url.hostname);
  const protocolValid = url.protocol === "https:" || url.protocol === "http:";
  const valid = protocolValid && (url.protocol !== "http:" || loopback);
  return {
    display: url.origin,
    valid,
    secure: url.protocol === "https:",
    loopback,
    reason: valid ? null : protocolValid ? "insecure_remote_http" : "unsupported_protocol",
  };
}

export function diagnoseOpenVikingConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const config = buildPluginConfig("copilot", { cwd, env });
  const endpoint = summarizeEndpoint(config.baseUrl);
  const files = loadCredentialFiles(env);
  const endpointConfigured = Boolean(
    env.OPENVIKING_URL
      || env.OPENVIKING_BASE_URL
      || files.cliFile.url
      || files.ovFile.server?.url,
  );
  const filters = describeInputFilters(config);
  const issues = [];

  if (!config.enabled) {
    issues.push({
      severity: "info",
      code: "integration_disabled",
      message: "OpenViking integration is disabled by configuration.",
    });
  }
  if (endpoint.reason === "missing") {
    issues.push({
      severity: "error",
      code: "server_url_missing",
      message: "No OpenViking server URL was resolved from environment or user configuration.",
      action: "Run the interactive setup command or configure OPENVIKING_URL / ovcli.conf.",
    });
  } else if (!endpointConfigured && endpoint.loopback) {
    issues.push({
      severity: "warning",
      code: "server_url_defaulted",
      message: "No server URL is configured; the shared resolver will use its local loopback default.",
      action: "Configure a URL explicitly if the OpenViking server is not running locally.",
    });
  } else if (!endpoint.valid) {
    issues.push({
      severity: "error",
      code: "server_url_invalid",
      message:
        endpoint.reason === "insecure_remote_http"
          ? "A non-loopback OpenViking server must use HTTPS."
          : "The configured OpenViking URL must use HTTP or HTTPS.",
      action: "Use an HTTPS endpoint, or HTTP only for a local loopback server.",
    });
  }
  if (endpoint.valid && config.authMode === "api_key" && !config.hasApiKey) {
    issues.push({
      severity: "warning",
      code: "api_key_missing",
      message: "No API key is configured; the server may reject authenticated requests.",
      action: "Configure OPENVIKING_API_KEY or set api_key in the user ovcli.conf.",
    });
  }
  if (!config.autoRecall && !config.autoCapture) {
    issues.push({
      severity: "warning",
      code: "recall_and_capture_disabled",
      message: "Both automatic recall and capture are disabled.",
    });
  }
  for (const filter of filters) {
    if (filter.errors.length > 0) {
      issues.push({
        severity: "warning",
        code: "invalid_input_filters",
        message: `${filter.label} has ${filter.errors.length} invalid rule(s); invalid rules are ignored.`,
      });
    }
  }

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    mode: "local-only",
    status: issues.some((issue) => issue.severity === "error")
      ? "error"
      : issues.some((issue) => issue.severity === "warning")
        ? "warning"
        : "ok",
    server: {
      endpoint: endpoint.display,
      endpointValid: endpoint.valid,
      transport: endpoint.secure ? "https" : endpoint.loopback ? "http-loopback" : "http",
      authMode: config.authMode,
      apiKeyConfigured: config.hasApiKey,
      apiKeySource: config.apiKeySource || "none",
      credentialSource: config.credentialSource,
      userIdentityConfigured: Boolean(config.user),
      accountIdentityConfigured: Boolean(config.account),
    },
    behavior: {
      enabled: config.enabled,
      autoRecall: config.autoRecall && !config.noAutoInject,
      autoCapture: config.autoCapture,
      recallLimit: config.recallLimit,
      recallMaxTokens: config.recallMaxTokens,
      recallTokenBudget: config.recallTokenBudget,
      recallTimeoutMs: config.recallTimeoutMs,
      captureTimeoutMs: config.captureTimeoutMs,
      captureToolResults: config.captureToolResults,
    },
    filters: filters.map(({ key, total, active, errors }) => ({
      key,
      total,
      active,
      invalid: errors.length,
    })),
    localStateDirectory: resolve(
      env.OPENVIKING_COPILOT_STATE_DIR || join(homedir(), ".openviking", "copilot", "state"),
    ),
    issues,
  };
}
