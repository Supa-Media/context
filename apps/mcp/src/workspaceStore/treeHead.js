/**
 * A workspace's change signal for one reader, pushed by its object over the tree socket (`treeSockets.js`).
 *
 * A device that keeps a copy of a workspace (the app's offline mirror) needs to know when something it may see has
 * changed, so it can catch up then and not on a timer. That cue came from the control plane's change log
 * (`apps/convex/functions/nodesFeed.ts` `head`), which for a workspace whose notes live here is a copy written
 * behind. The owner decided on 2026-11-06 that nothing about a note waits on the control plane, and that the object
 * pushes a note's changes, its mail included, rather than anybody polling for them
 * (`docs/decisions/storage-and-credentials/no-convex-for-notes.md`).
 *
 * The head is a digest of what this reader may see: each visible note's path and version, and the version of the
 * rules it was judged by. So it moves exactly when something the reader may see changes (a note's text, which is
 * also its mail; a note added, moved or removed; the rules), and a change the reader may not see leaves it as it
 * was. It is the same after a reconnect when nothing changed, so a socket closed for re-authorization every few
 * minutes costs the device no catch-up.
 */

import { canSee } from "../privacy/engine.js";
import { parsedRules } from "./serve.js";

/** Writes are gathered this long before heads are worked out again, so a burst of saves is one pass. */
export const HEAD_GATHER_MS = 1_000;

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

async function digest(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The key two readers share when they see the same: their scope and their names. */
export const clearanceKey = (clearance) => `${clearance.scope}|${[...clearance.names].sort().join(",")}`;

/**
 * The head for one clearance, or `null` where nothing may be seen (no rules held: failing closed, as a listing does).
 * @param {{exec: Function}} sql
 * @param {object|null} held  the rules as `rows.rules("member")` holds them
 * @param {{scope: "private"|"team", names: ReadonlySet<string>}} clearance
 */
export async function headFor(sql, held, clearance) {
  if (held === null || held === undefined) return null;
  const { rules, overrides } = parsedRules(held);
  const lines = [`${held.accessVersion ?? ""}|${held.etag ?? ""}`];
  const files = all(sql.exec("SELECT path, etag FROM ws_rows WHERE gone = 0 AND kind = 'file' ORDER BY path"));
  for (const file of files) {
    if (typeof file.path !== "string" || !canSee(file.path, clearance.scope, rules, overrides, clearance.names)) continue;
    lines.push(`${file.path}\u0000${file.etag ?? ""}`);
  }
  return await digest(lines.join("\n"));
}
