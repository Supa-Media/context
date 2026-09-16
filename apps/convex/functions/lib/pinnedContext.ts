/**
 * Resolving the pinned context — the one shared workspace every account can
 * reach without having been invited to it.
 *
 * `packages/shared/src/pinnedContext.ts` argues *why* this is reach rather than
 * membership; this file is the whole of *how*, and it is one file on purpose.
 * Three call sites consume it — `contextsForGrant` (what an MCP session
 * covers), `listMyWorkspaces` (what the console lists) and `authorizeFileAccess`
 * (whether a note may be read) — and a fourth place deciding the same question
 * slightly differently is exactly how one of them comes to grant more than the
 * other two.
 *
 * ## The two rules, in the order they are applied
 *
 *  1. **A real membership always wins.** The people who run this workspace are
 *     `owner` and `editor` in it through ordinary invitations. Every function
 *     here looks for a `workspaceMembers` row first and stands down when it
 *     finds one, so nothing in this file can demote somebody in their own
 *     context, and nothing here can *promote* anybody either: the pinned role
 *     is `member` and there is no argument that changes it.
 *  2. **No row is written, ever.** This module is read-only against the
 *     database by construction — every function takes a `QueryCtx`, which has
 *     no `insert` or `patch`. If a future change wants to record something per
 *     person here, that is a different decision with a different privacy
 *     argument (see `listMembers`), not a small extension of this one.
 *
 * ## What it deliberately does not touch
 *
 * `requireWorkspaceAccess` — the tenant boundary in `workspaceAuth.ts` — is not
 * changed and must not be. Roughly ninety call sites go through it, including
 * the member list, the audit trail, billing, the storage binding, OAuth grants,
 * shares, groups and invitations. Teaching *it* about the pin would hand every
 * account all of those in this workspace in a single edit. The pin is added at
 * the three narrow places above instead, each of which is a read.
 */

import { PINNED_CONTEXT_ROLE, PINNED_CONTEXT_SLUG } from "@context/shared";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { getMembership } from "./workspaceAuth";

/**
 * The pinned workspace, or `null` when this deployment has none.
 *
 * `null` is the ordinary answer on a self-hosted deployment and on a fresh test
 * database, not an error: the slug is a constant but the *row* is data, and a
 * control plane with no such workspace simply has no pinned context. Every
 * caller treats `null` as "the feature is not present here" and carries on.
 *
 * One indexed read on `by_slug`. It is on the hottest path in the system —
 * every MCP request resolves a session — which is why it is an index lookup and
 * never a scan with a filter.
 */
export async function pinnedContextWorkspace(
  ctx: QueryCtx,
): Promise<Doc<"workspaces"> | null> {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q) => q.eq("slug", PINNED_CONTEXT_SLUG))
    .unique();
}

/**
 * Does this person reach the pinned context *through the pin* — as opposed to
 * through a membership row, or not at all?
 *
 * `false` for all three of the cases that are not the pin, and the first two
 * matter for different reasons:
 *
 *  - **They are a real member.** Their own role governs; the caller should use
 *    it, and granting pinned access on top would silently widen nothing but
 *    would put a second answer in play.
 *  - **This is not the pinned workspace.** The overwhelmingly common case, and
 *    the reason the workspace id is compared before any membership read: a
 *    call about somebody else's private context must not turn into a lookup.
 *  - **This deployment has no pinned context.** See above.
 */
export async function reachesPinnedContext(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<boolean> {
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null) return false;
  if (pinned._id !== workspaceId) return false;
  return (await getMembership(ctx, workspaceId, userId)) === null;
}

/** One context in a reachable set: what both consumers need and nothing else. */
export interface PinnedContextRow {
  workspaceId: Id<"workspaces">;
  slug: string;
  role: string;
  kind: "personal" | "shared";
}

/**
 * The pinned context as a row to append to a reachable set, or `null`.
 *
 * `covered` is the ids the caller has already resolved from real memberships.
 * Passing it in rather than re-reading is what keeps the "a real membership
 * wins" rule honest at both call sites: `contextsForGrant` and
 * `listMyWorkspaces` each build that set for their own reasons, and a row that
 * is already in it must not appear twice — a duplicate `@context-lc` in the
 * rail is a visible bug, and a duplicate in `session.workspaces` would make
 * `sessionForContext`'s `.find()` answer with whichever came first, which is
 * the pinned `member` row rather than an owner's real one.
 *
 * The role is always `PINNED_CONTEXT_ROLE`. There is no path through this
 * function that returns anything else, which is the property the tests pin:
 * pinned reach cannot write, cannot see a private note, and cannot be widened
 * by anything a caller passes.
 */
export async function pinnedContextRow(
  ctx: QueryCtx,
  covered: ReadonlySet<Id<"workspaces">>,
): Promise<PinnedContextRow | null> {
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null) return null;
  if (covered.has(pinned._id)) return null;
  return {
    workspaceId: pinned._id,
    slug: pinned.slug,
    role: PINNED_CONTEXT_ROLE,
    kind: pinned.kind,
  };
}
