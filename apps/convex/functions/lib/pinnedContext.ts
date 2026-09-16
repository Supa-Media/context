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
import { userIsStaff } from "./admin";
import { getMembership } from "./workspaceAuth";

/**
 * How many membership rows are examined for somebody who can vouch.
 *
 * The creator is checked first and is the answer wherever this is set up the
 * ordinary way, so the common path is one extra read. The scan exists for the
 * row whose creator has since left the allowlist, and it is capped because the
 * rows that reach it are the ones already failing the fast path — a claimed
 * name nobody vouches for must not cost an unbounded read per request.
 *
 * **The cap fails closed**, which is the right direction and is worth knowing
 * about: a pinned workspace whose only staff owner sits past this many
 * membership rows loses its pin rather than gaining a wrong one. Fifty is far
 * past the size of the team that runs a workspace like this, and the creator
 * check is the path that is meant to answer.
 */
const VOUCHERS_EXAMINED = 50;

/**
 * The pinned workspace, or `null` when this deployment has none.
 *
 * `null` is the ordinary answer on a self-hosted deployment and on a fresh test
 * database, not an error: the slug is a constant but the *row* is data, and a
 * control plane with no such workspace simply has no pinned context. Every
 * caller treats `null` as "the feature is not present here" and carries on.
 *
 * ## THE SLUG SELECTS THE ROW. IT DOES NOT MAKE IT THE PINNED CONTEXT.
 *
 * `context-lc` is deliberately claimable: `lib/names.ts` reserves its
 * lookalikes and says of the name itself that *"what protects a name we hold is
 * holding it"*, because a reserved name is refused for everyone **including
 * us**, and we could then never recreate this workspace after a delete or a
 * migration. That argument is sound and is not reopened here — but it was made
 * about a **handle**, and this feature is what turns the same string into a
 * **trust anchor**: whatever row holds it is read by every account on the
 * deployment and appears in every MCP session.
 *
 * Anywhere the row is not already held — a self-hosted control plane, a fresh
 * staging database, this one after a delete frees the name — the first account
 * to create a workspace called `context-lc` would otherwise be pinned into
 * every rail and every session. That is an author's notes reaching every user's
 * agent under a handle that reads as ours, and, since `participatesInForms`
 * asks only for a write-scoped grant and a **non-empty** role, a form of theirs
 * taking submissions from any user's client.
 *
 * So the row must also be something an account cannot give itself:
 *
 *  1. **`kind: "shared"`.** A personal context has a mailbox, an ingestion
 *     alias and an owner it is deleted with; it is not a thing to pin into
 *     everybody's list, and `pinnedContextRow` reports the row's own kind.
 *  2. **Somebody this deployment already trusts stands behind it** —
 *     `ADMIN_EMAILS`, which lives in the Convex environment exactly because
 *     nothing this codebase executes can write it (`lib/admin.ts`). Unset means
 *     nobody, so a deployment with no staff has no pinned context: the same
 *     answer a self-hoster already got, and the one they should keep.
 *
 * Neither is configuration anybody has to set for this to keep working where it
 * already does; both are facts the deployment already carries.
 *
 * One indexed read on `by_slug` plus, only when the row exists, the vouching
 * read. It is on the hottest path in the system — every MCP request resolves a
 * session — which is why it is an index lookup and never a scan with a filter.
 */
export async function pinnedContextWorkspace(
  ctx: QueryCtx,
): Promise<Doc<"workspaces"> | null> {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q) => q.eq("slug", PINNED_CONTEXT_SLUG))
    .unique();
  if (workspace === null) return null;
  if (workspace.kind !== "shared") return null;
  if (!(await vouchedFor(ctx, workspace))) return null;
  return workspace;
}

/** Does somebody this deployment trusts stand behind this row? */
async function vouchedFor(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
): Promise<boolean> {
  if (await userIsStaff(ctx, workspace.createdBy)) return true;
  const owners = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .take(VOUCHERS_EXAMINED);
  for (const membership of owners) {
    if (membership.role !== "owner") continue;
    if (membership.userId === workspace.createdBy) continue;
    if (await userIsStaff(ctx, membership.userId)) return true;
  }
  return false;
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
