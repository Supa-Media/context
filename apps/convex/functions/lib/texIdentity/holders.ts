/**
 * Who in a group chat can open a workspace the chat named (Dev2's privacy rulebook, rule 2, 2026-11-25:
 * "someone without access asking gets a neutral boundary naming who holds the keys"; decision record
 * `docs/decisions/texting-assistant/asker-reach.md`).
 *
 * A group turn somebody asked for reads the asker's own workspaces (`lib/textGroupReach.ts` `askerReach`), so when
 * Femi asks about a workspace he is not in, the turn reads nothing of it and has no way to say who here could pull it
 * up. This answers that one question, for one workspace the turn names: the handles of the people in this chat with
 * an account who are members of the shared workspace by that handle or name. It lists nothing on its own: a workspace
 * nobody here is in gets the same answer as one that does not exist, so it tells the room no more than who here is in
 * the workspace it already named. It never names a personal workspace or the pinned one, and it reads no note.
 *
 * Only a group chat's home-only grant asks, on a live token (never a job's run token); the people are the chat's
 * home people as the last tag found them (`textGroups.homeUsers`). Every refusal is `null`.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { resolveLiveGrant } from "../controlPlane/liveGrants";
import { pinnedContextWorkspace } from "../pinnedContext";
import { handleFor } from "../../texPage";

/** A group chat's grant (`textGroups.ts` `TEXTS_GROUP_CLIENT_ID`). */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
/** Most people read: an iMessage group holds at most 32. */
export const MAX_HOLDER_PEOPLE = 32;
/** Most memberships read per person: nobody is in this many. */
const MEMBERSHIP_SCAN = 200;
const MAX_NAME = 80;

export type Holders = { slug: string | null; holders: string[] };

/** A workspace's handle or name as the chat said it, lower case, `@` and spacing dropped: "Crystal Care" is "crystal-care". */
export function holderKey(value: string): string {
  return value
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function matches(workspace: Doc<"workspaces">, key: string): boolean {
  return workspace.slug === key || holderKey(workspace.displayName) === key;
}

export async function workspaceHoldersHandler(ctx: QueryCtx, args: { hashedAccessToken: string; workspace: string }): Promise<Holders | null> {
  if (args.workspace.length > MAX_NAME) return null;
  const key = holderKey(args.workspace);
  if (key === "") return null;
  // `resolveLiveGrant`, never the run grants: a job's token asks nothing of the room.
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  if (live === null || live.grant.clientId !== TEXTS_GROUP_CLIENT_ID) return null;
  const group = live.grant.texGroup;
  if (group === undefined || group.homeOnly !== true) return null;
  const chat = await ctx.db.get(group.groupId);
  if (chat === null) return null;
  const pin = await pinnedContextWorkspace(ctx);
  const people = [...new Set<Id<"users">>(chat.homeUsers ?? [])].slice(0, MAX_HOLDER_PEOPLE);
  const bySlug = new Map<string, Set<Id<"users">>>();
  for (const userId of people) {
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MEMBERSHIP_SCAN);
    for (const membership of memberships) {
      const workspace = await ctx.db.get(membership.workspaceId);
      if (workspace === null || workspace.kind !== "shared" || (pin !== null && workspace._id === pin._id)) continue;
      if (!matches(workspace, key)) continue;
      const holders = bySlug.get(workspace.slug) ?? new Set<Id<"users">>();
      holders.add(userId);
      bySlug.set(workspace.slug, holders);
    }
  }
  if (bySlug.size === 0) return { slug: null, holders: [] };
  // The handle itself first, then a name match; two names alike are told apart by handle order.
  const slug = bySlug.has(key) ? key : [...bySlug.keys()].sort()[0];
  const handles: string[] = [];
  for (const userId of bySlug.get(slug) ?? []) {
    const handle = await handleFor(ctx, userId);
    if (handle !== "") handles.push(handle);
  }
  return { slug, holders: handles.sort() };
}
