/**
 * Display formatting for the console. Pure, so the awkward cases — a grant that
 * has never been used, a scope set nobody anticipated — are pinned by tests
 * rather than discovered in production.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "4 minutes ago" / "2 hours ago" / "yesterday", matching the mockup's copy.
 *
 * Deliberately coarse: this is a reassurance signal ("something is using it"),
 * not an audit log. Future timestamps read as "just now" rather than producing
 * a negative duration when a client's clock runs ahead.
 */
export function relativeTime(timestamp: number, now: number): string {
  const delta = now - timestamp;
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) {
    const minutes = Math.floor(delta / MINUTE);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (delta < 2 * DAY) return "yesterday";
  const days = Math.floor(delta / DAY);
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** "last used 4 minutes ago", or the mockup's "never used". */
export function lastUsedLabel(lastUsedAt: number | undefined, now: number): string {
  if (lastUsedAt === undefined) return "never used";
  return `last used ${relativeTime(lastUsedAt, now)}`;
}

/**
 * Scopes → the access phrase in the mockup.
 *
 * The gateway's scope vocabulary is not frozen yet, so this maps what it can
 * and otherwise shows the raw scopes rather than inventing a reassuring
 * summary. Reaching private notes is the distinction that matters: `team` is
 * named people, and a client holding only that cannot see anything the owner
 * marked private.
 */
const PRIVATE_SCOPES = new Set(["private", "context:private", "context.private", "*"]);
const TEAM_SCOPES = new Set(["team", "context:team", "context.team"]);

export function describeScopes(scopes: readonly string[]): string {
  if (scopes.some((scope) => PRIVATE_SCOPES.has(scope))) return "Full access";
  if (scopes.length > 0 && scopes.every((scope) => TEAM_SCOPES.has(scope))) {
    return "Team access only";
  }
  if (scopes.length === 0) return "No scopes";
  return scopes.join(" · ");
}

/**
 * A grant's status pip. A revoked grant should not be on the list at all, but
 * if one arrives it reads as critical rather than fine.
 */
export function grantTone(status: string, lastUsedAt: number | undefined): "ok" | "warn" | "crit" {
  if (status !== "active") return "crit";
  // Matches the mockup: Notion AI is amber precisely because it has never been
  // used — an authorised client that has never connected is worth a second look.
  if (lastUsedAt === undefined) return "warn";
  return "ok";
}

/** Thousands separators without pulling in `Intl` formatting differences. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** "@seyi" from "seyi"; leaves an already-prefixed name alone. */
export function atName(slug: string): string {
  return slug.startsWith("@") ? slug : `@${slug}`;
}

/**
 * The rail's status pip for a context. Storage that has never verified, or has
 * an error, is the thing worth surfacing at a glance.
 */
export function contextTone(storageStatus: string | undefined): "ok" | "warn" | "crit" {
  if (storageStatus === undefined) return "warn";
  if (storageStatus === "connected") return "ok";
  if (storageStatus === "error") return "crit";
  return "warn";
}
