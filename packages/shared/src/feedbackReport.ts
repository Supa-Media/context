/**
 * The shape of an in-app feedback report, shared by the app that builds one
 * and the control plane that accepts it (`apps/convex/functions/feedback.ts`).
 *
 * The app already keeps every field to a safe shape; the control plane checks
 * again rather than trusting it, because a report is the one path in the
 * product that carries telemetry to a vendor on purpose. Both halves read
 * these definitions, so the two checks cannot drift apart.
 */

/** Where the report was opened from. */
export const FEEDBACK_SOURCES = ["top_bar", "menu", "error", "settings"] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

export const FEEDBACK_LIMITS = {
  /** The message, in characters, after trimming. */
  messageChars: 4_000,
  /** Lines in the activity log (the app keeps at most ten minutes). */
  activityLines: 200,
  /** The whole activity log, as UTF-8. */
  activityBytes: 32_000,
  /** The screenshot, as stored. */
  screenshotBytes: 2 * 1024 * 1024,
  /** Reports accepted per person in any 24 hours. */
  perDay: 10,
} as const;

/**
 * Every static segment of the app's routes. A segment that is not one of
 * these is a value somebody typed or was handed — a handle, a note path, a
 * capability — so telemetry replaces it with a placeholder.
 *
 * Kept in step with `apps/mobile/app/` by `observabilityPrivacy.test.ts`,
 * which walks the route tree and fails on a static route missing from here.
 */
export const ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  "admin",
  "authorize",
  "cli",
  "connect",
  "connections",
  "console",
  "dropbox",
  "e2e-fixture",
  "google",
  "invite",
  "join",
  "login",
  "map",
  "meetings",
  "new",
  "note",
  "onboarding",
  "preview",
  "privacy",
  "s",
  "search",
  "settings",
  "terms",
  "welcome",
  "workspace",
]);

/** What a value segment becomes: named for the three worth telling apart. */
export const ROUTE_PLACEHOLDERS: ReadonlySet<string> = new Set([":context", ":token", ":value"]);

const MAX_ROUTE_LENGTH = 200;

/**
 * Whether `route` is a cleaned route name (`telemetryRoute`'s output): `/`, or
 * segments that are each a static route name or a placeholder. Anything else
 * could be a note path or a handle.
 */
export function isCleanRoute(route: string): boolean {
  if (route === "/") return true;
  if (route.length > MAX_ROUTE_LENGTH || !route.startsWith("/")) return false;
  const parts = route.slice(1).split("/");
  return parts.every(
    (part) => ROUTE_PLACEHOLDERS.has(part) || (part !== "" && ROUTE_SEGMENTS.has(part.toLowerCase()) && /^[A-Za-z0-9-]+$/.test(part)),
  );
}

/** An error's class name, as the activity log records it: letters only. */
export const ERROR_NAME_PATTERN = /^[A-Za-z]{1,40}$/;

/**
 * Whether `line` is one line of the activity log (`formatActivity`): a time, and
 * either a cleaned route or an error's class name with the first eight
 * characters of its Sentry reference.
 */
export function isActivityLine(line: string): boolean {
  const opened = /^([01]\d|2[0-3]):[0-5]\d {2}opened {2}(\S+)$/.exec(line);
  if (opened !== null) return isCleanRoute(opened[2]!);
  return /^([01]\d|2[0-3]):[0-5]\d {2}error {3}[A-Za-z]{1,40}( · ref [0-9a-f]{8})?$/.test(line);
}

/** A Sentry event id: 32 lowercase hex characters. */
export const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The id the app gives a report, so a retry is recognised: 96 random bits as
 * hex (`newClientReportId`).
 */
export const CLIENT_REPORT_ID_PATTERN = /^[0-9a-f]{24}$/;

/** The platforms a report can come from. */
export const FEEDBACK_PLATFORMS = ["web", "ios", "android"] as const;
export type FeedbackPlatform = (typeof FEEDBACK_PLATFORMS)[number];

/** A build or system version: digits, letters and dots, short. */
export const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;

/** A browser or system family, from a closed list; anything else is "other". */
export const SYSTEM_FAMILIES = [
  "chrome",
  "safari",
  "firefox",
  "edge",
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "other",
] as const;
export type SystemFamily = (typeof SYSTEM_FAMILIES)[number];
