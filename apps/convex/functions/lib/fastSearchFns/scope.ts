/**
 * Which contexts a blended search may ask: `searchScopeFor` and the handlers
 * for `fastSearch.searchableContexts` and `searchableContextsFor`.
 *
 * Split out of `functions/fastSearch.ts` — see that file's header for the
 * gate this surfaces and the owner-only rules around it, and see each
 * export's own doc comment there for its rules.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { fastSearchState, searchProjectionState } from "../fastSearch";
import { bindingFor, planFor, requireUserId } from "./helpers";
import type { SearchableContext } from "./validators";

/**
 * Contexts one person may search at once.
 *
 * The same order of magnitude as `listMyWorkspaces`' own cap and for the same
 * reason: a bounded read rather than a scan whose cost is somebody's
 * membership count. A fan-out has a second reason — every context in this list
 * is a request to a customer's storage, so the number is also the width of the
 * widest search anybody can cause with one keystroke.
 */
const SEARCHABLE_CONTEXT_CAP = 50;

/**
 * Every context this person may run a blended search over, and how each one
 * will answer.
 *
 * One condition decides membership of this list, and it is live: **a
 * membership row exists right now.** Not "existed when the page loaded" — the
 * search page re-asks this on every page of every query, so somebody removed
 * from a workspace between two pages gets the second one without it.
 *
 * ## What the second condition used to be, and why it is a field instead
 *
 * `searchProjectionState(...) === "ready"` used to gate the list, and the
 * argument for it was cost: a context without a projection answers from the R2
 * shard index in the customer's own bucket — a manifest read, some shard
 * reads, a snippet read per hit — and eight of those inside one request is a
 * lot of round trips for contexts the word is mostly not in.
 *
 * That is a real cost and it is the wrong thing to spend a person's search on.
 * The page it produced said "no context you can reach has fast search switched
 * on, so nothing was searched" to somebody with four contexts and a question,
 * and offered them a settings screen. **Nothing is a worse answer than slow**,
 * and the cost is already bounded where costs belong: `files.searchContexts`
 * gives every source its own deadline, so the slow ones cost their own rows
 * and the page still renders whatever answered.
 *
 * A `preparing` context is included now for the same reason, and it is safe
 * for a reason that is easy to miss: the gateway's projection reader
 * (`search/d1/serve.js`) treats a miss as "go and ask the R2 index the
 * expensive way" rather than as an answer — "only a *hit* short-circuits" — so
 * a half-built index can never lose a result the slow path would have found.
 * What it can do is be *slower* than a finished one, which is a row on the
 * page and not a reason to leave a context out of somebody's search.
 *
 * A context is named here only because the caller is in it, so this is not an
 * oracle: it enumerates the caller's own **live** memberships, which
 * `listMyWorkspaces` already returns in full.
 */
export async function searchScopeFor(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<SearchableContext[]> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(SEARCHABLE_CONTEXT_CAP);

  const contexts: SearchableContext[] = [];
  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace === null) continue;
    const binding = await bindingFor(ctx, membership.workspaceId);
    const plan = await planFor(ctx, membership.workspaceId);
    const serving = searchProjectionState(workspace, plan, binding) === "ready";
    const state = fastSearchState(workspace, plan, binding);
    contexts.push({
      workspaceId: workspace._id,
      slug: workspace.slug,
      displayName: workspace.displayName,
      kind: workspace.kind,
      role: membership.role,
      search: serving ? "fast" : "slow",
      // `fastSearchState` can answer "on" for a binding whose status is
      // "ready" but has no recorded database id yet — a narrower window than
      // `searchProjectionState` accepts. That context is searched slowly, so
      // its own state must not claim otherwise: "preparing" is the honest word
      // for "opted in and not yet actually serving", which is what the window
      // is, and it is the word the settings card uses for it.
      fastSearch: serving ? "on" : state === "on" ? "preparing" : state,
      owner: membership.role === "owner",
    });
  }

  contexts.sort((a, b) => a.slug.localeCompare(b.slug));
  return contexts;
}

export async function searchableContextsHandler(
  ctx: QueryCtx,
): Promise<{ contexts: SearchableContext[] }> {
  const userId = await requireUserId(ctx);
  return { contexts: await searchScopeFor(ctx, userId) };
}

export async function searchableContextsForHandler(
  ctx: QueryCtx,
  args: { actorUserId: Id<"users"> },
): Promise<SearchableContext[]> {
  return await searchScopeFor(ctx, args.actorUserId);
}
