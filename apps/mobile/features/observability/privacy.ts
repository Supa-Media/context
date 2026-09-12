/**
 * Privacy boundary for telemetry.
 *
 * Context handles note bodies, OAuth callbacks and share URLs. None of those
 * belong in an analytics event or an error-report breadcrumb. Keep the rules
 * here, vendor-independent, so Sentry and PostHog cannot drift apart.
 */

// `note` is here beside the credentials because the canonical console address
// is `/console/@slug?note=<path>`, and a note's path is its title.
const SECRET_QUERY_VALUE = /([?&](?:code|token|secret|key|note|access_token|refresh_token|id_token)=)[^&#\s]*/gi;
const AUTH_HEADER = /(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s,"'}]+/gi;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const CALLBACK_SECRET = /(\/(?:invite|s)\/)[^/?#\s]+/gi;
const CONTEXT_PATH = /(\/console\/)[^/?#\s]+/gi;
// `/note/@slug/<path>` — everything after the keyword, not just the handle.
// This route carries a whole note path, which `CONTEXT_PATH`'s one-segment
// shape would leave standing from the second segment on.
const NOTE_ADDRESS = /(\/note\/)[^\s"'`)\]}>]*/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/** Remove credentials and unguessable URL capabilities from diagnostic text. */
export function redactTelemetryText(value: string): string {
  return value
    .replace(SECRET_QUERY_VALUE, "$1[redacted]")
    .replace(AUTH_HEADER, "$1[redacted]")
    .replace(AWS_ACCESS_KEY, "[redacted-access-key]")
    .replace(CALLBACK_SECRET, "$1:token")
    .replace(CONTEXT_PATH, "$1:context")
    .replace(NOTE_ADDRESS, "$1:address")
    .replace(EMAIL, "[redacted-email]");
}

/**
 * Every static path segment this app's route tree contains.
 *
 * **The allowlist is the boundary, and the named cases below it are only
 * labels.** An enumeration of the prefixes known to be sensitive is a rule that
 * has to be extended every time a route is added, and the route it was not
 * extended for was `app/note/[...address].tsx` — a whole note path, reaching
 * PostHog as a `$screen_name` and Sentry as a navigation breadcrumb. A segment
 * that is not a route name is a value somebody typed or was handed, so it is
 * replaced whether or not anybody thought about it.
 *
 * Kept in step with `app/` by `observabilityPrivacy.test.ts`, which walks the
 * route tree and fails on a static route missing from here — so a new route
 * makes this list wrong loudly rather than making telemetry leak quietly.
 */
export const ROUTE_SEGMENTS = new Set([
  "admin",
  "authorize",
  "connect",
  "connections",
  "console",
  "dropbox",
  "e2e-fixture",
  "google",
  "invite",
  "login",
  "map",
  "meetings",
  "new",
  "note",
  "s",
  "search",
  "settings",
  "welcome",
  "workspace",
]);

/** What a segment carrying a value becomes when no rule gives it a better name. */
const OPAQUE_SEGMENT = ":value";

/**
 * Turn concrete Expo Router paths into low-cardinality, non-identifying names.
 * Context handles, note paths and invitation/share capabilities must never
 * become events.
 */
export function telemetryRoute(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  // Names for the three that are worth telling apart in a funnel. Everything
  // else — including every segment after these — falls to the allowlist below,
  // which is what actually decides.
  const named = [...parts];
  if ((named[0] === "console" || named[0] === "note") && named.length >= 2) {
    named[1] = ":context";
  }
  if ((named[0] === "invite" || named[0] === "s") && named.length >= 2) {
    named[1] = ":token";
  }
  const safe = named.map((part, index) =>
    part !== parts[index] || ROUTE_SEGMENTS.has(part.toLowerCase())
      ? part
      : OPAQUE_SEGMENT,
  );
  return safe.length === 0 ? "/" : `/${safe.join("/")}`;
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
