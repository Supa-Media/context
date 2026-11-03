/** How long the object keeps a writer's mark before it expires (`apps/mcp/src/workspaceStore/marks.js` `MAX_MARK_MS`). */
export const MARK_TTL_MS = 10 * 60 * 1000;

/** A mark's token: random, URL-safe, and nothing else (`marks.js` takes 8 to 128 of `[A-Za-z0-9_-]`). */
export function markToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  return `m${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`.slice(0, 63);
}
