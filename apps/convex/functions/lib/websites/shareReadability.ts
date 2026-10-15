/**
 * Which shared notes a website page's links may keep (Dev2, 2026-10-14: names,
 * existence and front matter come from the tree; storage is read only to open
 * a note's body). The answer is the tree's, never a bucket read.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";

/** Share rows a page's links are checked against per tree query. */
const SHARE_ROWS_PER_QUERY = 100;

/**
 * The shared notes a page's links may keep. A note is readable when the
 * publication clearance may see it (the tree answers only for those) and it is
 * not sealed, the same test the bucket read this replaced applied to an
 * encrypted note. A tree that does not serve, or any failed query, keeps no
 * link: the same empty answer a failed bucket read gave.
 */
export async function readableSharePaths(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  paths: readonly string[],
): Promise<Set<string>> {
  const readable = new Set<string>();
  for (let at = 0; at < paths.length; at += SHARE_ROWS_PER_QUERY) {
    const rows = await ctx
      .runQuery(internal.functions.nodeFacts.publishedRows, {
        workspaceId,
        paths: paths.slice(at, at + SHARE_ROWS_PER_QUERY),
      })
      .catch(() => null);
    if (rows === null) return new Set();
    for (const row of rows) {
      if (!row.sealed) readable.add(row.path);
    }
  }
  return readable;
}
