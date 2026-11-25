/**
 * Who here can't open a workspace the asker's turn reads (Dev2, 2026-11-16, after the Crystal Care chat lost its
 * workspace overnight when someone joined who isn't a member; changed 2026-11-25, rulebook rule 2).
 *
 * A turn somebody asked for reads the ASKER's own shared workspaces (`lib/textGroupReach.ts` `askerReach`), not only
 * the ones everyone here shares; the chat-wide reach (every account holder here a member, every person with no
 * account invited by number) is what a routine, a check-in or the hello reads. This module names, for the turn, each
 * of the asker's shared workspaces the whole chat does not share, and who here is not in it: the account holders who
 * are not members, and the people with no account who aren't invited by number. The turn logs it, and Tex uses it to
 * judge what fits the room (a summary by default; Training teaches it), or, on a run nobody asked for, says what
 * keeps the chat out and what fixes it ("Tex, add everyone here").
 *
 * What it tells the chat: that the asker is in a workspace by that name, and who here is not. Both are the asker's
 * own to say (they asked in this chat), and a non-member learns no more than its name, which is how sharing is
 * addressed anyway. A workspace the asker is not in is never named, whoever else here is in it.
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
 * Who here is not in each of the asker's shared workspaces the chat as a whole does not reach (`chatReach`), by slug,
 * empty when the chat shares them all.
 * `people` are the accounts here, named by handle (or by `label` when they have none), `guests` the numbers with no
 * account and the labels they are named by.
 */
export async function reachBlockers(
  ctx: MutationCtx,
  input: {
    asker: Id<"users"> | null;
    people: { userId: Id<"users">; label: string }[];
    guests: { phone: string; label: string }[];
    /** The workspaces the whole chat shares this turn (`lib/textGroupReach.ts` `reachOf` over everyone here). */
    chatReach: Id<"workspaces">[];
  },
): Promise<Blocker[]> {
  // A guest who asked has no workspaces of their own to name; only an account holder's ask names any.
  if (input.asker === null) return [];
  const pin = await pinnedContextWorkspace(ctx);
  const reached = new Set(input.chatReach);
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", input.asker as Id<"users">))
    .take(MEMBERSHIP_SCAN);
  const candidates: Doc<"workspaces">[] = [];
  for (const membership of memberships) {
    if (reached.has(membership.workspaceId)) continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace === null || workspace.kind !== "shared" || (pin !== null && workspace._id === pin._id)) continue;
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
