/**
 * A group chat's home-only grant (E1 of the guest-mode retirement, decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/group-guests.md`, `chat-homes.md`).
 *
 * A chat that not everyone shares a workspace with, and a guest who tags Tex, are answered from the chat's home
 * (`tex/groups/<words>/` in the pinned workspace, `lib/textGroupHome.ts`) and from nothing else. The grant is minted
 * on the pinned workspace for the chat's SPONSOR, the account that brought Tex in and pays for its turns; it reads
 * only that home, as the chat reads (`READS_AS_CHAT`, `lib/nodes/chatFolders.ts`), and it is held to edit only the
 * home's own row. It needs no membership of the pin, since the pin's readers have none: its reach is the home's row
 * alone, and it resolves only while the chat is not muted and the sponsor still may text.
 *
 * A guest who tags Tex is recorded by number (`texGroup.guestPhone`, `lib/textGroupUsage.ts` `usageWho`); an account
 * holder who tags is recorded as themselves (`texGroup.taggerId`). Numbers live in the control plane only.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { SCOPE_READ, SCOPE_WRITE } from "./consentScopes";
import { recordAudit } from "./audit";
import { phoneSignInPaused } from "./emailProof";
import { ensureGroupClient } from "./textGroupClient";
import { ensureChatHome, chatHomeOf } from "./textGroupHome";
import { handleOf, linkedUser } from "./textGroupAccounts";
import { guestLabel } from "./textGroupGuests";
import { pinnedContextWorkspace } from "./pinnedContext";
import { READS_AS_CHAT_NAME } from "./nodes/chatFolders";
import { accountTimeZone } from "./routines/access";
import { effectiveTimeZone } from "./routines/model";
import { personalWorkspaceOf } from "../textLinks";

/** The client every group grant is minted for, and its name (`functions/textGroups.ts` holds the same two). */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
const TEXTS_GROUP_CLIENT_NAME = "Tex (group chats)";

/** What a home-only turn is asked: the tag or command the Worker sent, and the grant to mint if it answers. */
export interface HomeOnlyArgs {
  groupKey: string;
  sender: string;
  command?: unknown;
  mint: boolean;
  hashedAccessToken: string;
  hashedRefreshToken: string;
  expiresAt: number;
}

/** A home-only turn's answer, before the chat's style and mail are added (`functions/textGroups.ts`). */
export interface HomeOnlyReady {
  slug: string;
  intro: boolean;
  timeZone: string;
  handle: string;
  minted: boolean;
  names: { phone: string; handle: string }[];
  guests: { phone: string; label: string }[];
  guestTagger?: string;
}

/**
 * One tag in a chat answered from its home: the chat's home is made (or kept) and its people named, and, when the
 * turn mints, the grant is written. Null when there is no pin on this deployment, no one who may pay for the chat,
 * or the grant cannot be written: the chat is then answered as it was before (no shared workspace).
 */
export async function homeOnlyTurn(
  ctx: MutationCtx,
  args: HomeOnlyArgs,
  chat: Doc<"textGroups">,
  senderUser: Id<"users"> | null,
  others: string[],
): Promise<HomeOnlyReady | null> {
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null) return null;
  const names: { phone: string; handle: string }[] = [];
  const guests: { phone: string; label: string }[] = [];
  const people: Id<"users">[] = [];
  for (const phone of others) {
    const userId = phone === args.sender ? senderUser : await linkedUser(ctx, phone);
    if (userId === null) {
      guests.push({ phone, label: await guestLabel(args.groupKey, phone) });
      continue;
    }
    if (!people.includes(userId)) people.push(userId);
    names.push({ phone, handle: await handleOf(ctx, userId) });
  }
  // The sponsor brought Tex in and pays: set once (`textGroupUsage.ts`). Before the row has one, whoever is here with an account.
  const sponsor = chat.sponsorId ?? chat.boundBy ?? senderUser ?? people[0];
  if (sponsor === undefined) return null;
  const intro = chat.introducedAt === undefined;
  const minted = args.mint && args.command === undefined;
  if (minted) {
    const ok = await mintHomeOnlyGrant(ctx, {
      chat,
      pinned,
      sponsor,
      people,
      tagger: senderUser,
      guestPhone: senderUser === null ? args.sender : undefined,
      hashedAccessToken: args.hashedAccessToken,
      hashedRefreshToken: args.hashedRefreshToken,
      expiresAt: args.expiresAt,
      participants: others.length,
    });
    if (!ok) return null;
  }
  const introduced = intro && minted;
  if (introduced) await ctx.db.patch(chat._id, { introducedAt: Date.now() });
  const timeZone = effectiveTimeZone(undefined, await accountTimeZone(ctx, senderUser ?? sponsor));
  const handle = senderUser === null ? "" : await handleOf(ctx, senderUser);
  return {
    slug: pinned.slug,
    intro: introduced,
    timeZone,
    handle,
    minted,
    names,
    guests,
    ...(senderUser === null ? { guestTagger: await guestLabel(args.groupKey, args.sender) } : {}),
  };
}

/**
 * The chat's home made (or kept) with its people named, and its grant written on the pin for the sponsor. Returns
 * false, and writes nothing else, when the sponsor may not pay or the home has no name.
 */
async function mintHomeOnlyGrant(
  ctx: MutationCtx,
  input: {
    chat: Doc<"textGroups">;
    pinned: Doc<"workspaces">;
    sponsor: Id<"users">;
    people: Id<"users">[];
    tagger: Id<"users"> | null;
    guestPhone?: string;
    hashedAccessToken: string;
    hashedRefreshToken: string;
    expiresAt: number;
    participants: number;
  },
): Promise<boolean> {
  const meterWorkspace = (await phoneSignInPaused(ctx, input.sponsor)) ? null : await personalWorkspaceOf(ctx, input.sponsor);
  if (meterWorkspace === null) return false;
  const folder = await ensureChatHome(ctx, input.chat, input.people, input.sponsor);
  if (folder === null) return false;
  await ensureGroupClient(ctx, TEXTS_GROUP_CLIENT_ID, TEXTS_GROUP_CLIENT_NAME);
  // The home is the one thing this grant may change; its row's own role (`liveGrants.ts`) says it is an editor's.
  const scopes = [SCOPE_READ, SCOPE_WRITE];
  const texGroup = {
    groupId: input.chat._id,
    coViewerIds: [] as Id<"users">[],
    meterWorkspaceId: meterWorkspace,
    homeOnly: true as const,
    ...(input.tagger === null ? {} : { taggerId: input.tagger }),
    ...(input.guestPhone === undefined ? {} : { guestPhone: input.guestPhone }),
  };
  const token = {
    scopes,
    texGroup,
    hashedRefreshToken: input.hashedRefreshToken,
    hashedAccessToken: input.hashedAccessToken,
    accessTokenExpiresAt: input.expiresAt,
  };
  // One live grant per chat per sponsor: a new turn's token replaces the last.
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", input.pinned._id).eq("userId", input.sponsor))
    .collect();
  const reusable = grants.find(
    (grant) =>
      grant.clientId === TEXTS_GROUP_CLIENT_ID && grant.status === "active" && grant.texGroup?.homeOnly === true && grant.texGroup.groupId === input.chat._id,
  );
  if (reusable === undefined) {
    await ctx.db.insert("oauthGrants", { workspaceId: input.pinned._id, userId: input.sponsor, clientId: TEXTS_GROUP_CLIENT_ID, ...token, status: "active", createdAt: Date.now() });
  } else {
    await ctx.db.patch(reusable._id, token);
  }
  if (input.chat.sponsorId === undefined) await ctx.db.patch(input.chat._id, { sponsorId: input.sponsor });
  // The audit names the home's path, which in the pin is shown to its actor alone (`audit.ts`).
  await recordAudit(ctx, {
    workspaceId: input.pinned._id,
    actorUserId: input.sponsor,
    actorClientId: TEXTS_GROUP_CLIENT_ID,
    action: "texts.group.session.opened",
    paths: [folder],
    details: { scopes: scopes.join(" "), participants: input.participants, homeOnly: true },
  });
  return true;
}

/**
 * What a home-only grant reads: its chat's home, as one row of the pin, read as the chat reads (`READS_AS_CHAT`), held
 * at the editor's hand, and nothing else of the pin, nor any workspace. `[]` when the chat has no home.
 */
export async function homeOnlyRows(
  ctx: QueryCtx,
  grant: Doc<"oauthGrants">,
  workspace: Doc<"workspaces">,
): Promise<
  Array<{
    workspaceId: Id<"workspaces">;
    slug: string;
    role: string;
    kind: "personal" | "shared";
    grantedNames: string[];
    chatHome: string;
    homeOnly: true;
  }>
> {
  const groupId = grant.texGroup?.groupId;
  if (groupId === undefined) return [];
  const home = await chatHomeOf(ctx, groupId);
  if (home === null || home.workspaceId !== grant.workspaceId) return [];
  const token = `#${home.noteId}`;
  return [
    {
      workspaceId: home.workspaceId,
      slug: workspace.slug,
      role: "editor",
      kind: workspace.kind,
      grantedNames: [READS_AS_CHAT_NAME, token, `${token}!edit`],
      chatHome: home.folder,
      homeOnly: true,
    },
  ];
}

/**
 * Whether a home-only grant still resolves: the sponsor who minted it is still the chat's sponsor and may still text,
 * and the grant is for the pin. The chat's mute is checked by the caller (`liveGrants.ts` `groupStillShares`).
 */
export async function homeOnlyStillShares(ctx: QueryCtx, grant: Doc<"oauthGrants">, group: Doc<"textGroups">): Promise<boolean> {
  if (group.sponsorId === undefined || group.sponsorId !== grant.userId) return false;
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null || pinned._id !== grant.workspaceId) return false;
  return !(await phoneSignInPaused(ctx, grant.userId));
}
