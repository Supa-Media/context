/**
 * Which paths a share may point at, and how far a share reaches from there.
 *
 * Split out of `functions/shares.ts`, which keeps every registered function;
 * this module registers none.
 */

import { ConvexError } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import { normalizePath } from "../fileOps";
import type { Invitee } from "../invitees";
import { isPlumbing } from "../privacy";

/**
 * The path a share may point at, or a refusal.
 *
 * Three separate judgments, and the order is what makes the refusals honest:
 * a path that does not normalize is malformed (`PATH_INVALID`), and a path that
 * normalizes fine but names something no share may ever cover is a different
 * answer (`PATH_NOT_SHAREABLE`). Collapsing them would tell somebody who typed
 * `privacy.md` that their path was malformed, which it is not.
 *
 * The `.md` requirement is a v1 boundary rather than a security property: the
 * viewer renders Markdown, and a share pointing at a PDF would be a download
 * link with no page to show. Attachments referenced *from* a shared note are a
 * separate problem the read path will have to answer.
 */
export type PathCheck =
  | { ok: true; path: string }
  | { ok: false; code: "PATH_INVALID" | "PATH_NOT_SHAREABLE"; message: string };

/**
 * The path a **folder** link may point at.
 *
 * Not `checkSharePath` with the `.md` test removed: a folder and an
 * extensionless file are the same string, which `checkTeamSharePath` already
 * records as the reason "note or folder" was never implementable from a path.
 * So the *caller* declares which it meant and this checks the rest — and the
 * declaration is proved against the bucket by the listing probe in
 * `createLinkShare` before any row is written.
 *
 * The root is refused. A link over `""` is a link to the whole context, which
 * is not a folder share with a wide reach but a different product — and every
 * bound below is expressed relative to a prefix that a root would make empty.
 */
export function checkFolderSharePath(input: string): PathCheck {
  const path = normalizePath(input);
  if (path === null || path === "") {
    return { ok: false, code: "PATH_INVALID", message: "That path is not valid." };
  }
  if (isPlumbing(path)) {
    return {
      ok: false,
      code: "PATH_NOT_SHAREABLE",
      message:
        "That folder is part of how this context works, not a folder of notes. It cannot be shared.",
    };
  }
  return { ok: true, path };
}

/**
 * Is `path` inside the folder this share is rooted at?
 *
 * **The trailing slash is the whole function.** `startsWith(folder)` hands over
 * `1-projects/transition-old` to a link minted on `1-projects/transition` —
 * a different folder whose name merely begins with the shared one's, which is
 * the kind of near-miss that reads correct and leaks a sibling. Equality is
 * allowed separately so the folder itself can be listed.
 *
 * Both sides arrive through `normalizePath`, so a dot-segment climb has already
 * been resolved or refused before this is asked; this is the bound, not the
 * sanitiser.
 */
export function withinSharedFolder(folder: string, path: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

export function checkSharePath(input: string): PathCheck {
  const path = normalizePath(input);
  if (path === null) {
    return { ok: false, code: "PATH_INVALID", message: "That path is not valid." };
  }
  if (isPlumbing(path)) {
    return {
      ok: false,
      code: "PATH_NOT_SHAREABLE",
      message:
        "That file is part of how this context works, not a note. It cannot be shared.",
    };
  }
  if (!path.toLowerCase().endsWith(".md")) {
    return {
      ok: false,
      code: "PATH_NOT_SHAREABLE",
      message: "Only a note can be shared.",
    };
  }
  return { ok: true, path };
}

/**
 * The path a **team link** may point at: anything that is not plumbing.
 *
 * The motivating case is a folder — a team link grants nothing, it is an
 * address whose reader is authorised by membership, so "a link to this folder"
 * is a sentence that means something where "share this folder with one
 * outsider" is not: that would have to decide what a folder share reaches, and
 * it is a scope nobody asked for. Personal shares stay note-only, and
 * `checkSharePath` above is what keeps them there.
 *
 * **But the rule is not "a note or a folder", and an earlier version of this
 * comment said it was** — "wider than `checkSharePath` by exactly one thing: a
 * folder". It is wider by everything that is not `.md`: an image, a PDF, a
 * spreadsheet, an extensionless file. That is deliberate and it is safe for the
 * same reason the folder case is — a member can already read those at their
 * tier and the link confers nothing — but it is a different sentence, and
 * "exactly one thing" would have sent somebody tightening this to a rule that
 * silently breaks links to attachments. There is no way to tell a folder from
 * an extensionless file by path alone anyway, so "note or folder" was never
 * implementable here.
 *
 * Plumbing is refused for both. `.history/` is every revision of every note and
 * `privacy.md` is the access map; neither is a thing to hand anybody a link to,
 * whatever their membership.
 */
export function checkTeamSharePath(input: string): PathCheck {
  const path = normalizePath(input);
  if (path === null) {
    return { ok: false, code: "PATH_INVALID", message: "That path is not valid." };
  }
  if (isPlumbing(path)) {
    return {
      ok: false,
      code: "PATH_NOT_SHAREABLE",
      message:
        "That file is part of how this context works, not a note. It cannot be shared.",
    };
  }
  return { ok: true, path };
}

export function pathRejection(
  check: Extract<PathCheck, { ok: false }>,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: check.code, message: check.message });
}

/**
 * The one row a share to this recipient over this note would occupy, if any.
 *
 * `.unique()` is safe for `findInvitationFor`'s reason: every write goes
 * through this lookup first and Convex mutations are serializable, so a second
 * insert for the same tuple reads the same index range and the loser re-runs.
 */
export async function findShareFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  entryPath: string,
  recipient: Invitee,
): Promise<Doc<"noteShares"> | null> {
  return await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_entry_recipient", (q) =>
      q
        .eq("workspaceId", workspaceId)
        .eq("entryPath", entryPath)
        .eq("recipientKind", recipient.kind)
        .eq("recipient", recipient.value),
    )
    .unique();
}

/**
 * What a share reaches: the note it names, plus the notes that note links to.
 *
 * One hop, not a graph walk, and that boundary is a decision rather than a
 * first draft. The handoff proposed following links from "already authorized"
 * notes with a depth cap, which sounds equivalent and is not: at depth two, a
 * note the owner linked to becomes a *source* of authorization, so anybody with
 * `editor` on this context can extend somebody else's share by adding a link to
 * a note that was never part of it. Depth one keeps the whole grant a function
 * of one note the owner chose and read.
 *
 * It is also the only version that can be stated to a person in one sentence —
 * "they can read this note and the notes it links to" — and a sharing rule
 * nobody can predict is a sharing rule nobody can use safely.
 *
 * If a packet ever needs to be deeper than this, the answer is the explicit
 * allowlist the handoff names as the fallback, not a bigger number here.
 */
export const SHARE_TRAVERSAL_DEPTH = 1;
