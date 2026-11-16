/**
 * Who keeps a group chat from a shared workspace (Dev2, 2026-11-16, after the Crystal Care chat lost its workspace
 * overnight when someone joined who isn't a member, and Tex could only say "this chat can't see it").
 *
 * A chat's reach is every shared workspace that ALL its account holders and its sponsor are members of and every
 * person with no account is invited to by number (`lib/textGroupReach.ts`). This module only names, for the turn, why a
 * workspace is missing: for each shared workspace the asker and the sponsor are both members of that the chat does not
 * reach, the account holders here who are not members of it, and the people with no account who aren't invited to it
 * by number. The turn logs it and Tex can say who it is and what fixes it ("Tex, add everyone here"), by text.
 *
 * What it tells the chat: that the asker and the sponsor share a workspace by that name, and who here is not in it.
 * Both are the asker's own to say (they asked in this chat), and a non-member learns no more than its name, which is
 * how sharing is addressed anyway. A workspace only the sponsor is in, with an asker who isn't, is never named.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { handleOf } from "./textGroupAccounts";
import { pinnedContextWorkspace } from "./pinnedContext";
import { getMembership } from "./workspaceAuth";
import { pendingPhoneInvitation } from "./textGroupInvited";

/** Most workspaces named per turn, and most people named per workspace: a turn needs the first few, never a roster. */
export const MAX_BLOCKED_WORKSPACES = 3;
export const MAX_BLOCKERS = 8;
/** Most memberships read for the asker: nobody is in this many. */
const MEMBERSHIP_SCAN = 200;

/** One person who keeps the chat from one workspace, and why: not a member there, or no account and not invited by number. */
export interface Blocker {
  slug: string;
  who: string;
  why: "not_member" | "no_account";
}

/**
 * Why the chat misses each shared workspace its asker and sponsor both belong to, by slug, empty when it misses none.
 * `people` are the accounts here, named by handle (or by `label` when they have none), `guests` the numbers with no
 * account and the labels they are named by.
 */
export async function reachBlockers(
  ctx: MutationCtx,
  input: {
    asker: Id<"users"> | null;
    sponsor: Id<"users">;
    people: { userId: Id<"users">; label: string }[];
    guests: { phone: string; label: string }[];
    reach: Id<"workspaces">[];
  },
): Promise<Blocker[]> {
  // A guest who asked has no workspaces of their own to name; only an account holder's ask names any.
  if (input.asker === null) return [];
  const pin = await pinnedContextWorkspace(ctx);
  const reached = new Set(input.reach);
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", input.asker as Id<"users">))
    .take(MEMBERSHIP_SCAN);
  const candidates: Doc<"workspaces">[] = [];
  for (const membership of memberships) {
    if (reached.has(membership.workspaceId)) continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace === null || workspace.kind !== "shared" || (pin !== null && workspace._id === pin._id)) continue;
    if (input.sponsor !== input.asker && (await getMembership(ctx, workspace._id, input.sponsor)) === null) continue;
    candidates.push(workspace);
  }
  candidates.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const handles = new Map<Id<"users">, string>();
  const handle = async (userId: Id<"users">) => {
    if (!handles.has(userId)) handles.set(userId, await handleOf(ctx, userId));
    return handles.get(userId) as string;
  };
  const blocked: Blocker[] = [];
  for (const workspace of candidates.slice(0, MAX_BLOCKED_WORKSPACES)) {
    const here: Blocker[] = [];
    const seen = new Set<Id<"users">>();
    for (const person of input.people) {
      if (seen.has(person.userId)) continue;
      seen.add(person.userId);
      if ((await getMembership(ctx, workspace._id, person.userId)) !== null) continue;
      here.push({ slug: workspace.slug, who: (await handle(person.userId)) || person.label, why: "not_member" });
    }
    const now = Date.now();
    for (const guest of input.guests) {
      if ((await pendingPhoneInvitation(ctx, workspace._id, guest.phone, now)) !== null) continue;
      here.push({ slug: workspace.slug, who: guest.label, why: "no_account" });
    }
    blocked.push(...here.slice(0, MAX_BLOCKERS));
  }
  return blocked;
}
