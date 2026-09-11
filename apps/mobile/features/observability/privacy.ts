/**
 * Privacy boundary for telemetry.
 *
 * Context handles note bodies, OAuth callbacks and share URLs. None of those
 * belong in an analytics event or an error-report breadcrumb. Keep the rules
 * here, vendor-independent, so Sentry and PostHog cannot drift apart.
 */

const SECRET_QUERY_VALUE = /([?&](?:code|token|secret|key|access_token|refresh_token|id_token)=)[^&#\s]*/gi;
const AUTH_HEADER = /(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s,"'}]+/gi;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const CALLBACK_SECRET = /(\/(?:invite|s)\/)[^/?#\s]+/gi;
const CONTEXT_PATH = /(\/console\/)[^/?#\s]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/** Remove credentials and unguessable URL capabilities from diagnostic text. */
export function redactTelemetryText(value: string): string {
  return value
    .replace(SECRET_QUERY_VALUE, "$1[redacted]")
    .replace(AUTH_HEADER, "$1[redacted]")
    .replace(AWS_ACCESS_KEY, "[redacted-access-key]")
    .replace(CALLBACK_SECRET, "$1:token")
    .replace(CONTEXT_PATH, "$1:context")
    .replace(EMAIL, "[redacted-email]");
}

/**
 * Turn concrete Expo Router paths into low-cardinality, non-identifying names.
 * Context handles and invitation/share capabilities must never become events.
 */
export function telemetryRoute(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "console" && parts.length >= 2) parts[1] = ":context";
  if ((parts[0] === "invite" || parts[0] === "s") && parts.length >= 2) {
    parts[1] = ":token";
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/** Recursively redact the small JSON-shaped values Sentry places in breadcrumbs. */
export function redactTelemetryValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactTelemetryText(value);
  if (value === null || typeof value !== "object") return value;
  // Sentry events are JSON-shaped, but a defensive ceiling keeps an unexpected
  // host object from recursing forever. Replacing is safer than returning raw.
  if (depth >= 8) return "[redacted-depth]";
  if (Array.isArray(value)) return value.map((item) => redactTelemetryValue(item, depth + 1));

  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/authorization|cookie|password|secret|token|note(?:body|content)?/i.test(key)) {
      clean[key] = "[redacted]";
    } else {
      clean[key] = redactTelemetryValue(item, depth + 1);
    }
  }
  return clean;
}
