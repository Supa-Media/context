/**
 * A linked page's card is its cover (owner, 2026-10-27: "Team links too", on
 * which shared pages preview their cover).
 *
 * A `.page.md` note with a cover (`nodes.pageCover`, the first screen Tex
 * drew of it) that the owner has linked unfurls with that picture rather than
 * the title card: a team link (`members`) and a link for anyone. A link for
 * named people keeps the title card, since its token reaches people who were
 * not on the list. This is the one place a card shows a note's content, and
 * it is the owner's call, recorded in
 * `docs/decisions/privacy-and-sharing/page-covers.md`: a team link's address
 * is guessable, so a team-linked page's first screen is readable by anyone
 * who guesses it. Revoking the link, or turning its title off, takes the
 * cover off the card for future crawls, as it does the title.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { hashTitle } from "../cardKey";

/** Whether a share's card may be its page's cover: a note link to a `.page.md`, for the team or for anyone. */
export function isCoverable(share: Doc<"noteShares">): boolean {
  if (share.entryKind === "folder") return false;
  if (!/\.page\.md$/i.test(share.entryPath)) return false;
  return share.recipientKind === "members" || share.recipientKind === "anyone";
}

/** The cover a live share's card shows, or `null` for the title card. The caller has checked the share is live and titled. */
export async function pageCoverLeaf(db: QueryCtx["db"], share: Doc<"noteShares">): Promise<string | null> {
  if (!isCoverable(share)) return null;
  const row = await livePageRow(db, share.workspaceId, share.entryPath);
  return row?.pageCover ?? null;
}

/** The live file row at a `.page.md` path, or `null`. */
export async function livePageRow(db: QueryCtx["db"], workspaceId: Id<"workspaces">, path: string): Promise<Doc<"nodes"> | null> {
  if (!/\.page\.md$/i.test(path)) return null;
  const rows = await db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .collect();
  return rows.find((row) => row.goneAt === undefined && row.kind === "file") ?? null;
}

/** The cache key a cover's card URL carries: a new cover is a new address, the only invalidation the edge has. */
export function coverVersion(leaf: string): string {
  return hashTitle(`cover:${leaf}`);
}
