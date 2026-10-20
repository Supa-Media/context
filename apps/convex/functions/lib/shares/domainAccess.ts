import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import { myDomains } from "../domainMembership";
import { isPersonalMailDomain } from "../emailDomains";
import { getMembership } from "../workspaceAuth";

/**
 * A share page's way in through an email domain (Dev, 2026-10-20).
 *
 * A link to a note in a workspace opened to everyone at a domain is read-only
 * to whoever holds it, and the person it was sent to is very often somebody at
 * that domain who could edit it the moment they signed in. So the read path
 * reports the domain, and the page says "sign in with your @domain email to
 * edit it" instead of a flat "only people in this workspace can change it".
 *
 * ## What this tells somebody holding a link
 *
 * The domain, and whether joining through it edits or reads. Never the
 * workspace's name or slug: the share page calls it "Shared with you" on
 * purpose, and `joinWithDomain`'s rule that nobody learns *which* workspaces a
 * domain opens still holds, because the reader is not told which workspace
 * this is. The owner chose both halves of what is disclosed: they opened the
 * workspace to the domain, and they sent the link.
 *
 * `joinSlug` is the one exception, and is only ever handed to a signed-in
 * reader with a confirmed address at the domain who is not a member yet:
 * exactly the person `myDomainWorkspaces` already lists that workspace to.
 * The page sends them to the note's own address there, where the app's layout
 * joins them (`DomainJoin`) and runs the domain sign-up (phone, personal
 * email) before drawing the note.
 */
export const domainAccessValidator = v.union(
  v.null(),
  v.object({
    /** Lower case, no `@`. */
    domain: v.string(),
    /** Whether joining through the domain lets them edit, or only read. */
    canEdit: v.boolean(),
    /** The workspace's slug, for a reader who can join it right now. */
    joinSlug: v.union(v.string(), v.null()),
  }),
);

export type DomainAccess = Infer<typeof domainAccessValidator>;

/** More than any workspace has (`MAX_DOMAINS_PER_WORKSPACE`). */
const ROW_LIMIT = 11;

/**
 * The domain a share's reader could join its workspace through, or `null`.
 *
 * `null` for a member of any role (they are in already; an editor is sent to
 * the console by `editableInContext`), for a personal workspace, and for a
 * workspace with no domain switched on.
 */
export async function domainAccessFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  actorUserId: Id<"users"> | null,
): Promise<DomainAccess> {
  const workspace = await ctx.db.get(workspaceId);
  if (workspace === null || workspace.kind !== "shared") return null;
  if (actorUserId !== null && (await getMembership(ctx, workspaceId, actorUserId)) !== null) return null;

  const rows = (
    await ctx.db
      .query("workspaceDomains")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .take(ROW_LIMIT)
  ).filter((row) => row.enabled && !isPersonalMailDomain(row.domain));
  if (rows.length === 0) return null;

  const held = actorUserId === null ? new Map<string, string>() : await myDomains(ctx, actorUserId);
  const mine = rows.filter((row) => held.has(row.domain));
  const row = pick(mine.length > 0 ? mine : rows);
  return {
    domain: row.domain,
    canEdit: row.role === "editor",
    joinSlug: mine.length > 0 ? workspace.slug : null,
  };
}

/** The editing row first, then the earliest added: one answer, every read. */
function pick(rows: Doc<"workspaceDomains">[]): Doc<"workspaceDomains"> {
  return [...rows].sort(
    (a, b) => Number(b.role === "editor") - Number(a.role === "editor") || a.addedAt - b.addedAt,
  )[0]!;
}
