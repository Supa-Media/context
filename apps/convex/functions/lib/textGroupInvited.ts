/**
 * Invited family in a Tex group chat (the owner, 2026-10-27;
 * `docs/decisions/texting-assistant/invited-family.md`).
 *
 * The owner runs a business with their family in one iMessage chat. The
 * family won't accept an invitation, and guest mode (`textGroupGuests.ts`)
 * gives such a chat only a corner of the workspace. So the owner says "Tex,
 * add everyone here to @slug" in the chat, which invites each person in it by
 * the number they text from, and a pending phone invitation counts as
 * membership in that chat: Tex works there on the whole workspace, at team
 * tier, as it does for a chat of members.
 *
 * - Only an owner of a shared workspace may add the chat to it. A personal
 *   workspace never: it carries its owner's mail, calendar and vault.
 * - Each person must be a member or hold a pending phone invitation to it.
 *   One stranger in the chat, and it answers as it would without this.
 * - Somebody with an account who holds one joins at once: the number is
 *   theirs, by code, and the owner invited it. So does anyone who later
 *   links or signs up with it (`lib/invitations/join.ts`).
 * - An invited person who tags Tex acts through the owner or editor who bound
 *   the chat, never as them: nothing is ever held for that person's yes from
 *   their turn, and their role is the invitation's, never more than editor.
 * - The grant resolves only while every invitation it counted is still
 *   pending, or answered by somebody still a member (`liveGrants.ts`), so the
 *   owner revoking one in Members stops the chat's next call.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { phoneSignInPaused } from "./emailProof";
import { accountForPhone } from "./identities";
import { isPending } from "./invitations/forCaller";
import { findInvitationFor, inviteMemberWithId } from "./invitations/invite";
import { joinByInvitation } from "./invitations/join";
import { getMembership } from "./workspaceAuth";

/** The client every group grant is minted for; the audit names it beside the person. */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";

/** Who in a chat counts in a workspace: members by number, and invitations by number. */
export type InvitedChat = {
  workspace: Doc<"workspaces">;
  members: Map<string, Id<"users">>;
  invited: Map<string, Doc<"workspaceInvitations">>;
};

/** The pending phone invitation to `phone` in this workspace, or null. */
export async function pendingPhoneInvitation(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  phone: string,
  now: number,
): Promise<Doc<"workspaceInvitations"> | null> {
  const row = await findInvitationFor(ctx, workspaceId, { kind: "phone", value: phone });
  return row !== null && isPending(row, now) ? row : null;
}

/**
 * Whether every person in the chat counts in `workspace`: a member, or a number
 * with a pending phone invitation there. Somebody with an account holding one
 * joins now. Null when anyone counts as neither, when anyone's texting is
 * paused, or when the workspace is not a shared one.
 */
export async function invitedChat(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  others: string[],
  now: number,
): Promise<InvitedChat | null> {
  if (workspace.kind !== "shared") return null;
  const members = new Map<string, Id<"users">>();
  const invited = new Map<string, Doc<"workspaceInvitations">>();
  for (const phone of others) {
    const account = await accountForPhone(ctx, phone);
    if (account !== null && (await phoneSignInPaused(ctx, account))) return null;
    if (account !== null && (await getMembership(ctx, workspace._id, account)) !== null) {
      members.set(phone, account);
      continue;
    }
    const invitation = await pendingPhoneInvitation(ctx, workspace._id, phone, now);
    if (invitation === null) return null;
    if (account === null) {
      invited.set(phone, invitation);
      continue;
    }
    const joined = await joinByInvitation(ctx, invitation, account, now, { via: "phone" });
    if (joined === null) return null;
    members.set(phone, account);
  }
  return { workspace, members, invited };
}

/** The workspace a "use" or "add" names, by slug; null for none. */
export async function workspaceBySlug(ctx: QueryCtx, slug: string): Promise<Doc<"workspaces"> | null> {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

/**
 * "Tex, add everyone here to @slug": one phone invitation per person in the
 * chat who isn't a member, as `role`, from `owner`. Null when they may not
 * (not an owner, not a shared workspace, no such name: one answer), else how
 * many were invited. The chat is bound there, out of guest mode, by the caller.
 */
export async function inviteEveryone(
  ctx: MutationCtx,
  owner: Id<"users">,
  slug: string,
  others: string[],
  role: "editor" | "member",
): Promise<{ workspace: Doc<"workspaces">; count: number } | null> {
  const workspace = await workspaceBySlug(ctx, slug);
  if (workspace === null || workspace.kind !== "shared") return null;
  const membership = await getMembership(ctx, workspace._id, owner);
  if (membership === null || membership.role !== "owner") return null;
  let count = 0;
  for (const phone of others) {
    const account = await accountForPhone(ctx, phone);
    if (account === owner) continue;
    if (account !== null && (await getMembership(ctx, workspace._id, account)) !== null) continue;
    const id = await inviteMemberWithId(ctx, owner, { workspaceId: workspace._id, invitee: phone, role }, { actorClientId: TEXTS_GROUP_CLIENT_ID });
    if (id !== null) count += 1;
  }
  return { workspace, count };
}

/**
 * Whether the invitations a chat's grant counted still count: each still
 * pending in that workspace, or answered by somebody who is a member there now.
 */
export async function invitationsStillCount(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  ids: Id<"workspaceInvitations">[],
): Promise<boolean> {
  const now = Date.now();
  for (const id of ids) {
    const invitation = await ctx.db.get(id);
    if (invitation === null || invitation.workspaceId !== workspaceId || invitation.inviteeKind !== "phone") return false;
    if (isPending(invitation, now)) continue;
    if (invitation.status !== "accepted") return false;
    const account = await accountForPhone(ctx, invitation.invitee);
    if (account === null || (await getMembership(ctx, workspaceId, account)) === null) return false;
  }
  return true;
}
