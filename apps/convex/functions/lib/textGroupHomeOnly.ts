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
import { keepEarlierToken } from "./controlPlane/earlierTokens";
import { ensureChatHome, chatHomeOf } from "./textGroupHome";
import { chatPerson, handleOf, linkedUser } from "./textGroupAccounts";
import { syncHomePhones } from "./guestPhones";
import { guestLabel } from "./textGroupGuests";
import { pinnedContextWorkspace } from "./pinnedContext";
import { READS_AS_CHAT_NAME } from "./nodes/chatFolders";
import { accountTimeZone } from "./routines/access";
import { effectiveTimeZone } from "./routines/model";
import { personalWorkspaceOf } from "../textLinks";
import { askerReach, liveReach, reachOf } from "./textGroupReach";
import { reachBlockers, type Blocker } from "./textGroupBlockers";
import { speaksUpOf } from "./texChatRules";

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
  /**
   * Whether somebody asked for this turn: a text, their job's report, their ask from another chat. It reads the
   * asker's own reach (`textGroupReach.ts` `askerReach`); a turn nobody asked for (a routine, a check-in, the hello)
   * reads the chat's.
   */
  asked: boolean;
}

/** A home-only turn's answer, before the chat's style and mail are added (`functions/textGroups.ts`). */
export interface HomeOnlyReady {
  slug: string;
  intro: boolean;
  timeZone: string;
  handle: string;
  minted: boolean;
  names: { phone: string; handle: string; name?: string }[];
  guests: { phone: string; label: string }[];
  guestTagger?: string;
  /** The slugs of the shared workspaces this turn reads, by name: the asker's own on a turn somebody asked for, the chat's on one nobody did (`lib/textGroupReach.ts`). */
  reach: string[];
  /** Who here is not in each of the asker's workspaces the whole chat doesn't share, so the turn logs it and Tex can judge the room (`lib/textGroupBlockers.ts`). */
  blocked: Blocker[];
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
  const names: { phone: string; handle: string; name?: string }[] = [];
  const guests: { phone: string; label: string }[] = [];
  const people: Id<"users">[] = [];
  const unnamed: { phone: string; label: string }[] = [];
  const named: { userId: Id<"users">; label: string }[] = []; // each account here, by its guest label for one with no handle
  for (const phone of others) {
    const userId = phone === args.sender ? senderUser : await linkedUser(ctx, phone);
    // A number with no account at all is a guest. One with an account, by a texted link or a confirmed sign-in (a
    // guest's light account from a note link, `functions/guestPass.ts`, included), is a person here (`linkedUser`).
    if (userId === null) {
      guests.push({ phone, label: await guestLabel(args.groupKey, phone) });
      continue;
    }
    if (!people.includes(userId)) people.push(userId);
    named.push({ userId, label: await guestLabel(args.groupKey, phone) });
    // Each account's name beside its handle, so the turn can say who is here (`packages/tex/gateway/agent/groupNames.js`). An
    // account with no handle yet (a light account) is told by its label, as a guest is, though it counts as a person.
    const person = await chatPerson(ctx, phone, userId);
    if (person.handle === "") unnamed.push({ phone, label: await guestLabel(args.groupKey, phone) });
    else names.push(person);
  }
  // The sponsor brought Tex in and pays: set once (`textGroupUsage.ts`). Before the row has one, whoever is here with an
  // account that can pay (a personal workspace to meter to), the tagger first: an app sign-in with no handle yet can't.
  const sponsor = chat.sponsorId ?? chat.boundBy ?? (await firstWhoCanPay(ctx, [...(senderUser === null ? [] : [senderUser]), ...people])) ?? senderUser ?? people[0];
  if (sponsor === undefined) return null;
  // The chat's reach, worked out now (`lib/textGroupReach.ts`): every shared workspace each account holder here, and the
  // sponsor, is a member of and every guest is invited to by number. Kept on the chat for its single-workspace readers
  // (mail shares, check-ins, routines), which speak to the whole room, and read by a turn nobody asked for.
  const reachPeople = [...new Set([...people, sponsor])];
  const reachGuests = guests.map((guest) => guest.phone);
  const chatReach = await reachOf(ctx, chat, reachPeople, reachGuests);
  const chatReachIds = chatReach.map((row) => row.workspace._id);
  await ctx.db.patch(chat._id, { reach: chatReachIds, reachPeople, reachGuests });
  // A turn somebody asked for reads the ASKER's own workspaces (rulebook rule 2, Dev2 2026-11-25), on a grant of the
  // asker's own, so another person's tag never changes what this turn's tokens, earlier tokens or job parts read.
  const own = args.asked ? await askerReach(ctx, chat, senderUser, sponsor, senderUser === null ? args.sender : null) : null;
  const reach = own?.rows ?? chatReach;
  const reachIds = reach.map((row) => row.workspace._id);
  const blocked = await reachBlockers(ctx, { asker: senderUser, people: named, guests, chatReach: chatReachIds });
  const intro = chat.introducedAt === undefined;
  const minted = args.mint && args.command === undefined;
  if (minted) {
    const ok = await mintHomeOnlyGrant(ctx, {
      chat,
      pinned,
      sponsor,
      // The asker's own grant when an account holder asked; a guest's ask and a run nobody asked for stand on the sponsor.
      holder: own !== null && senderUser !== null ? senderUser : sponsor,
      reachFor: own !== null ? "asker" : "chat",
      people,
      reach: reachIds,
      reachPeople: own?.people ?? reachPeople,
      reachGuests: own?.guests ?? reachGuests,
      tagger: senderUser,
      guestPhone: senderUser === null ? args.sender : undefined,
      hashedAccessToken: args.hashedAccessToken,
      hashedRefreshToken: args.hashedRefreshToken,
      expiresAt: args.expiresAt,
      participants: others.length,
    });
    if (!ok) return null;
    // The numbers of the people with no account, kept so a guest's code can open the home (`functions/guestPass.ts`).
    await syncHomePhones(ctx, chat._id, guests.map((guest) => guest.phone));
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
    guests: [...guests, ...unnamed],
    reach: reach.map((row) => row.workspace.slug),
    blocked,
    ...(senderUser === null ? { guestTagger: await guestLabel(args.groupKey, args.sender) } : {}),
  };
}

/** The first of `candidates` with a personal workspace to meter a chat's turns to, or undefined. */
async function firstWhoCanPay(ctx: MutationCtx, candidates: Id<"users">[]): Promise<Id<"users"> | undefined> {
  for (const userId of candidates) if ((await personalWorkspaceOf(ctx, userId)) !== null) return userId;
  return undefined;
}

/**
 * The chat's home made (or kept) with its people named, and its grant written on the pin for `holder`: the asker on a
 * turn an account holder asked for, else the sponsor. One grant per holder, chat, kind of reach and guest, so one
 * person's tag never rewrites what another's tokens read. Returns false, and writes nothing else, when the sponsor may
 * not pay or the home has no name.
 */
async function mintHomeOnlyGrant(
  ctx: MutationCtx,
  input: {
    chat: Doc<"textGroups">;
    pinned: Doc<"workspaces">;
    sponsor: Id<"users">;
    holder: Id<"users">;
    reachFor: "asker" | "chat";
    people: Id<"users">[];
    reach: Id<"workspaces">[];
    reachPeople: Id<"users">[];
    reachGuests: string[];
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
    reachFor: input.reachFor,
    reach: input.reach,
    reachPeople: input.reachPeople,
    reachGuests: input.reachGuests,
    ...(input.tagger === null ? {} : { taggerId: input.tagger, ownTagToken: input.hashedAccessToken }),
    ...(input.guestPhone === undefined ? {} : { guestPhone: input.guestPhone }),
  };
  const token = {
    scopes,
    texGroup,
    hashedRefreshToken: input.hashedRefreshToken,
    hashedAccessToken: input.hashedAccessToken,
    accessTokenExpiresAt: input.expiresAt,
  };
  // One grant per holder per chat, per kind of reach and per guest; a new turn's token replaces the last, which stays good
  // until its own expiry. A grant minted before reach was the asker's (no `reachFor`) is never reused: its earlier tokens
  // keep the chat's reach they were minted with, and it runs out on its own.
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", input.pinned._id).eq("userId", input.holder))
    .collect();
  const reusable = grants.find(
    (grant) =>
      grant.clientId === TEXTS_GROUP_CLIENT_ID &&
      grant.status === "active" &&
      grant.texGroup?.homeOnly === true &&
      grant.texGroup.groupId === input.chat._id &&
      grant.texGroup.reachFor === input.reachFor &&
      grant.texGroup.guestPhone === input.guestPhone,
  );
  if (reusable === undefined) {
    await ctx.db.insert("oauthGrants", { workspaceId: input.pinned._id, userId: input.holder, clientId: TEXTS_GROUP_CLIENT_ID, ...token, status: "active", createdAt: Date.now() });
  } else {
    await keepEarlierToken(ctx, reusable);
    await ctx.db.patch(reusable._id, token);
  }
  if (input.chat.sponsorId === undefined) await ctx.db.patch(input.chat._id, { sponsorId: input.sponsor });
  // The audit names the home's path, which in the pin is shown to its actor alone (`audit.ts`).
  await recordAudit(ctx, {
    workspaceId: input.pinned._id,
    actorUserId: input.holder,
    actorClientId: TEXTS_GROUP_CLIENT_ID,
    action: "texts.group.session.opened",
    paths: [folder],
    details: { scopes: scopes.join(" "), participants: input.participants, homeOnly: true, reachFor: input.reachFor },
  });
  return true;
}

/** A row a home-only grant reaches: the chat's home in the pin, or a shared workspace in the chat's reach. */
export interface HomeOnlyRow {
  workspaceId: Id<"workspaces">;
  slug: string;
  role: string;
  kind: "personal" | "shared";
  grantedNames?: string[];
  chatHome?: string;
  homeOnly?: true;
}

/**
 * What a home-only grant reads: its chat's home, as one row of the pin, read as the chat reads (`READS_AS_CHAT`), held
 * at the editor's hand, and nothing else of the pin; then one row per shared workspace in the chat's reach
 * (`lib/textGroupReach.ts`), at the lowest role among the chat's people there, at `team` tier and with no granted names,
 * so a note any one of them could not open is not reachable. The reach is re-read now, for every person and the
 * sponsor, so someone removed from a workspace drops it from this request on. `[]` when the chat has no home.
 */
export async function homeOnlyRows(ctx: QueryCtx, grant: Doc<"oauthGrants">, workspace: Doc<"workspaces">): Promise<HomeOnlyRow[]> {
  const groupId = grant.texGroup?.groupId;
  if (groupId === undefined) return [];
  const home = await chatHomeOf(ctx, groupId);
  if (home === null || home.workspaceId !== grant.workspaceId) return [];
  const token = `#${home.noteId}`;
  const rows: HomeOnlyRow[] = [
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
  for (const reach of await liveReach(ctx, grant.texGroup?.reach, grant.texGroup?.reachPeople, grant.userId, grant.texGroup?.reachGuests ?? [])) {
    rows.push({ workspaceId: reach.workspace._id, slug: reach.workspace.slug, role: reach.role, kind: reach.workspace.kind });
  }
  return rows;
}

/**
 * Whether a guest's light account may be named on this chat's home, and who it is named under: the chat has a home in
 * the pin, is not muted, and its sponsor (or the person who bound it) may still text. A home is written in the
 * sponsor's name (`ensureChatHome` tells `setAccessRow` `role: "owner"`), so a chat with nobody left to stand behind it
 * names nobody. Null when it may not.
 */
export async function homeBinder(ctx: QueryCtx, chat: Doc<"textGroups">): Promise<Id<"users"> | null> {
  if (speaksUpOf(chat) === "off") return null;
  const sponsor = chat.sponsorId ?? chat.boundBy;
  if (sponsor === undefined || (await chatHomeOf(ctx, chat._id)) === null) return null;
  return (await phoneSignInPaused(ctx, sponsor)) ? null : sponsor;
}

/**
 * Whether a home-only grant still resolves: the chat's sponsor still may text, and the grant is for the pin, held by
 * the sponsor, or by an asker of the chat for their own turns (`reachFor: "asker"`, `taggerId` the holder) while the
 * chat's home still names them. The chat's mute is checked by the caller (`liveGrants.ts` `groupStillShares`).
 */
export async function homeOnlyStillShares(ctx: QueryCtx, grant: Doc<"oauthGrants">, group: Doc<"textGroups">): Promise<boolean> {
  if (group.sponsorId === undefined) return false;
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null || pinned._id !== grant.workspaceId) return false;
  if (group.sponsorId !== grant.userId) {
    const asker = grant.texGroup?.reachFor === "asker" && grant.texGroup.taggerId === grant.userId;
    if (!asker || !(group.homeUsers ?? []).includes(grant.userId)) return false;
    if (await phoneSignInPaused(ctx, group.sponsorId)) return false;
  }
  return !(await phoneSignInPaused(ctx, grant.userId));
}
