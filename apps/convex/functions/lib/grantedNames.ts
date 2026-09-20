/**
 * The `@name` rules one person reaches, in one workspace.
 *
 * `privacy.md` may point a folder or a note at a name — `2-areas/hr:
 * @atlas-leads`, or `@kola` for one person. The manifest holds the
 * **reference**; this module answers the **fact**, which is the split the whole
 * design rests on: a name in a file travels with the bucket, stays legible on
 * export, and means nothing on its own, so removing somebody from the workspace
 * closes every folder they could reach at once without a byte of the customer's
 * storage being touched.
 *
 * ## Everything here is intersected with live membership
 *
 * Two sources, and both are intersected rather than trusted:
 *
 *  - **Groups of this workspace** the caller is a live member of. A
 *    `workspaceGroupMembers` row grants nothing by itself — the property
 *    `resolveGroupMembers` was written for, and until now only the console's
 *    listing depended on it. It is load-bearing on the read path here.
 *  - **Handles the caller personally answers to.** `identifiersForUser`
 *    gathers candidates and its own docstring says they are candidates:
 *    "every row it finds must still be put back through `resolveAddressedUser`
 *    before anything is shown, because only that function decides who an
 *    identifier belongs to". That instruction is followed literally below, and
 *    it is the difference between a handle and a claim to one.
 *
 * ## Why the caller's membership is re-checked here
 *
 * The only caller is `authorizeFileAccess`, which has just established
 * membership — so the check below is redundant *today*. It is here because this
 * function returns a **capability**, and a capability function that is safe
 * only because of what its caller happened to do first is one refactor away
 * from handing a group's folders to somebody who left. The cost is one indexed
 * read.
 *
 * ## Why this is not in `lib/clearance.ts`
 *
 * That module is pure and cannot reach a database, the same split
 * `lib/invitees.ts` and `lib/identities.ts` already keep: a clearance is a
 * value and must stay testable without a `ctx`, while resolving one is nothing
 * but database reads.
 */

import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { identifiersForUser, resolveAddressedUser } from "./identities";

/**
 * The most rows one of these lookups will scan.
 *
 * An unbounded `.collect()` is a read whose cost is set by whoever can insert
 * rows. Mirrors `MAX_GROUPS_PER_WORKSPACE` in `functions/groups.ts` and
 * `MAX_IDENTIFIERS_SCANNED` in `lib/identities.ts`; a caller in more groups
 * than this reaches the first hundred, which is a ceiling no real workspace
 * meets rather than a policy.
 */
const MAX_NAMES_SCANNED = 100;

/**
 * Every `@name` this person reaches rules through, in this workspace.
 *
 * Returned **without** the leading `@`, because that is how both
 * `workspaceGroups.name` and a workspace slug are stored; `clearanceOf` adds
 * the prefix once, where the comparison against `effectiveVisibility` happens.
 * Prefixing in two places is how a set lookup silently never matches.
 *
 * An empty array is the honest answer for a caller who is not a member, who is
 * in no group, and who has no handle — and all three are the same answer on
 * purpose, because a caller must not be able to tell them apart.
 */
export async function grantedNamesFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<string[]> {
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", userId),
    )
    .unique();
  if (membership === null) return [];

  const names = new Set<string>();

  const groupRows = await ctx.db
    .query("workspaceGroupMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_NAMES_SCANNED);
  for (const row of groupRows) {
    // `workspaceId` is denormalized onto the row precisely so a group of
    // another workspace cannot travel here on a shared user id. Checked
    // against the row rather than by loading the group, so a mismatch costs
    // nothing and cannot be skipped by a group that has since been deleted.
    if (row.workspaceId !== workspaceId) continue;
    const group = await ctx.db.get(row.groupId);
    if (group === null || group.workspaceId !== workspaceId) continue;
    names.add(group.name);
  }

  for (const identifier of await identifiersForUser(ctx, userId)) {
    if (identifier.kind !== "name") continue;
    // The gathering is candidates; this is the authority. A `names` row or a
    // personal workspace slug that resolves to somebody else — or to nobody,
    // which is what an ambiguous claim resolves to — grants nothing.
    const owner = await resolveAddressedUser(ctx, identifier);
    if (owner !== userId) continue;
    names.add(identifier.value);
  }

  return [...names];
}
