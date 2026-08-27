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
 * Scopes → the access phrase beside a connected client.
 *
 * This is where a narrowed grant becomes visible after the fact, and it has to
 * answer the two questions somebody actually has about a client they connected
 * last month: **how much of my context can it see**, and **can it change
 * anything**. So the phrase carries both — "Team access only · read-only" is
 * two facts, and either one alone leaves the other unanswered.
 *
 * Reaching private notes is the distinction that matters most: `team` is named
 * people, never the public, and a client without the tier scope cannot see
 * anything the owner marked private. That is now a real per-grant fact rather
 * than a consequence of who approved, which is what makes this line worth
 * reading at all — it used to say "Full access" for every owner's client
 * because that was the only thing an owner's client could be.
 *
 * The vocabulary is not frozen, so anything unrecognised is printed raw rather
 * than folded into a reassuring summary. A scope this function cannot describe
 * is a scope it must not hide.
 */
const PRIVATE_SCOPES = new Set([
  "private",
  "context:private",
  "context.private",
  "*",
  "context:*",
  "context.*",
  "all",
]);
const TEAM_SCOPES = new Set(["team", "context:team", "context.team"]);
const READ_SCOPES = new Set(["read", "context:read", "context.read", "notes:read"]);
const WRITE_SCOPES = new Set(["write", "context:write", "context.write", "notes:write"]);
const CAPTURE_SCOPES = new Set(["capture", "context:capture", "context.capture"]);

/** What a client can do, in one phrase, or `null` if it asked for no operation. */
function describeOperations(scopes: readonly string[]): string | null {
  const canRead = scopes.some((scope) => READ_SCOPES.has(scope));
  const canWrite = scopes.some((scope) => WRITE_SCOPES.has(scope));
  const canCapture = scopes.some((scope) => CAPTURE_SCOPES.has(scope));
  if (canWrite) return canRead ? "read & write" : "write only";
  if (canRead) return canCapture ? "read & capture" : "read-only";
  if (canCapture) return "capture only";
  return null;
}

export function describeScopes(scopes: readonly string[]): string {
  if (scopes.length === 0) return "No scopes";

  const operations = describeOperations(scopes);
  const namesATier = scopes.some(
    (scope) => PRIVATE_SCOPES.has(scope) || TEAM_SCOPES.has(scope),
  );
  // Nothing here is vocabulary we own. Summarising it as a tier would be
  // inventing the one fact this line exists to report, so the raw strings go
  // out unchanged — exactly as they did before.
  if (operations === null && !namesATier) return scopes.join(" · ");

  const tier = scopes.some((scope) => PRIVATE_SCOPES.has(scope))
    ? "Full access"
    : "Team access only";

  // Every scope that reached none of the buckets above still gets said, so a
  // grant carrying something we cannot describe cannot look narrower than it is.
  const undescribed = scopes.filter(
    (scope) =>
      !PRIVATE_SCOPES.has(scope) &&
      !TEAM_SCOPES.has(scope) &&
      !READ_SCOPES.has(scope) &&
      !WRITE_SCOPES.has(scope) &&
      !CAPTURE_SCOPES.has(scope),
  );

  return [tier, operations, ...undescribed].filter((part) => part !== null).join(" · ");
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
