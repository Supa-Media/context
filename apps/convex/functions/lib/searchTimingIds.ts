/**
 * The opaque ids of the search quality log (`functions/searchTimings.ts`).
 *
 * Convex never hashes anything here and never holds a key that could. An
 * actor and a hit arrive from the gateway already keyed with HMAC-SHA-256
 * under a key only the gateway derives (`apps/mcp/src/search/quality.js`), so
 * what is stored is 16 lowercase hex of a MAC, which this file only checks
 * the shape of. An unkeyed hash of a user id or a path is reversible by anyone
 * who can read this table, and so is never written.
 */

export const MAX_HITS = 10;

const ID_PATTERN = /^[0-9a-f]{16}$/;

export function isActorId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isHitId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Hits as sent, or `undefined` when the field is malformed: then it is dropped whole. */
export function validHits(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_HITS) return undefined;
  return value.every(isHitId) ? (value as string[]) : undefined;
}
