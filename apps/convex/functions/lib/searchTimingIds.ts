/**
 * The opaque ids of the search quality log (`functions/searchTimings.ts`).
 *
 * A row never holds a query, a path, a title or a snippet. What it holds
 * instead is a hash: the first 16 hex digits (8 bytes) of SHA-256 over a
 * labelled input. The label keeps an actor's hash from ever equalling a hit's,
 * and the workspace id in the input keeps one workspace's hashes from meaning
 * anything in another. Web Crypto, so it runs on the Convex runtime as is.
 */

export const MAX_HITS = 10;

const ACTOR_PATTERN = /^[0-9a-f]{16}$/;
const HIT_PATTERN = /^[0-9a-f]{16}$/;

export function isActorId(value: unknown): value is string {
  return typeof value === "string" && ACTOR_PATTERN.test(value);
}

export function isHitId(value: unknown): value is string {
  return typeof value === "string" && HIT_PATTERN.test(value);
}

/** Hits as sent, or `undefined` when the field is malformed: then it is dropped whole. */
export function validHits(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_HITS) return undefined;
  return value.every(isHitId) ? (value as string[]) : undefined;
}

async function sixteenHex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The searcher's actor, not tied to a workspace: the signed-in user's in the
 * app, the grant's (or the user's) in the gateway. Lookups for "searched again"
 * and for opens go by actor across workspaces, because a note opened in one
 * workspace can be the result of a search in another.
 */
export function actorFor(principal: string): Promise<string> {
  return sixteenHex(`search-actor:${principal}`);
}

/** A result's hash: its note id if known, else its path. The gateway computes the same. */
export function hitFor(workspaceId: string, noteOrPath: string): Promise<string> {
  return sixteenHex(`search-hit:${workspaceId}:${noteOrPath}`);
}
