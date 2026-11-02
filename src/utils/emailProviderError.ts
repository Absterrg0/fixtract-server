/**
 * Safe, specific descriptions of transactional-email provider failures.
 *
 * The Brevo SDK rejects with an `HttpError` whose message is always
 * "HTTP request failed"; the useful facts are `statusCode` and the JSON body
 * (`{ code, message }`). Logging the error object itself prints the HTTP
 * response and its originating request (whose headers carry the API key),
 * so callers must log only the description produced here.
 */

export type EmailProviderFailureKind =
  | "provider_auth" // key invalid/revoked, or sending IP not authorized
  | "provider_account" // plan/credits/account suspended
  | "request_rejected" // invalid recipient, sender or payload
  | "rate_limited"
  | "provider_unavailable"
  | "network"
  | "unknown";

export interface EmailProviderFailure {
  kind: EmailProviderFailureKind;
  statusCode: number | null;
  code: string | null;
  /** One-line description safe for console and EmailLog. */
  message: string;
}

const MAX_DETAIL = 300;

const redactUrls = (value: string): string =>
  value.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[redacted-url]";
    }
  });

// Long opaque tokens (API keys, signatures) never belong in a log line.
const redactTokens = (value: string): string =>
  value.replace(/\b(?:xkeysib|xsmtpsib)-[A-Za-z0-9-]+/g, "[redacted-key]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");

const clean = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const single = redactTokens(redactUrls(value)).replace(/\s+/g, " ").trim();
  if (!single) return null;
  return single.length > MAX_DETAIL ? `${single.slice(0, MAX_DETAIL)}…` : single;
};

const parseBody = (body: unknown): { code: string | null; message: string | null } => {
  let value = body;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { code: null, message: clean(value) };
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return { code: clean(record.code), message: clean(record.message) };
  }
  return { code: null, message: null };
};

const kindFor = (statusCode: number | null, code: string | null): EmailProviderFailureKind => {
  if (statusCode === 401 || statusCode === 403 || code === "unauthorized") return "provider_auth";
  if (statusCode === 402 || code === "not_enough_credits" || code === "account_under_validation") {
    return "provider_account";
  }
  if (statusCode === 429) return "rate_limited";
  if (statusCode !== null && statusCode >= 500) return "provider_unavailable";
  if (statusCode !== null && statusCode >= 400) return "request_rejected";
  return "unknown";
};

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export const describeEmailProviderError = (error: unknown): EmailProviderFailure => {
  const record = (error && typeof error === "object" ? error : {}) as Record<string, any>;
  const rawStatus = record.statusCode ?? record.response?.statusCode ?? record.status;
  const statusCode = typeof rawStatus === "number" && Number.isFinite(rawStatus) ? rawStatus : null;
  const body = parseBody(record.body ?? record.response?.body);
  const errno = typeof record.code === "string" ? record.code : null;

  if (statusCode === null && errno && NETWORK_CODES.has(errno)) {
    return {
      kind: "network",
      statusCode: null,
      code: errno,
      message: `Email provider unreachable (${errno})`,
    };
  }

  const kind = kindFor(statusCode, body.code);
  if (statusCode !== null) {
    const detail = [body.code, body.message].filter(Boolean).join(": ");
    return {
      kind,
      statusCode,
      code: body.code,
      message: `Brevo HTTP ${statusCode} [${kind}]${detail ? ` ${detail}` : ""}`,
    };
  }

  const fallback = clean(error instanceof Error ? error.message : typeof error === "string" ? error : null);
  return {
    kind,
    statusCode: null,
    code: errno,
    message: `Email send failed [${kind}]${fallback ? `: ${fallback}` : ""}`,
  };
};
