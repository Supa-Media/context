import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { phoneSignInPaused } from "./lib/emailProof";
import { recordAudit } from "./lib/audit";
import { SCOPE_READ, SCOPE_WRITE, clampScopes, hasOperationScope } from "./lib/consentScopes";
import { hashToken } from "./lib/crypto";
import { hasTexStyle, texStyleValidator, type TexStyle } from "./lib/texStyle";
import { accountTimeZone } from "./lib/routines/access";
import { effectiveTimeZone } from "./lib/routines/model";
import { isPhoneNumber, personalWorkspaceOf } from "./textLinks";
import { getMembership } from "./lib/workspaceAuth";
import { clearGuests, guestLabel, mayOpenToGuests } from "./lib/textGroupGuests";
import { homeOnlyTurn } from "./lib/textGroupHomeOnly";
import { inviteEveryone, invitedChat, workspaceBySlug, type InvitedChat } from "./lib/textGroupInvited";
import { cleanAddress, cleanShareQuery, mailSharesNamed, shareMail, unshareMail } from "./lib/textGroupMail";
import { armChatLook } from "./lib/textGroupLooks";
import { muteChat, setChatEngagement, unmuteChat } from "./lib/texChatRules";
import { ensureGroupClient } from "./lib/textGroupClient";
import { ensureChatHome } from "./lib/textGroupHome";
import { sponsorOf } from "./lib/textGroupUsage";
import { handleOf, linkedUser } from "./lib/textGroupAccounts";
import { chatWorkspace, reachOf } from "./lib/textGroupReach";
import { pinnedContextWorkspace } from "./lib/pinnedContext";

/**
 * Tex in an iMessage group chat: who is in it, and what it reaches.
 *
 * Decided by the owner on 2026-10-20 and changed on 2026-10-31 (`docs/decisions/texting-assistant/groups.md`):
 *
 * - **Everyone counts, or nobody does.** Every participant but the line the message arrived on must be a phone linked
 *   by code (`phoneLinks`), with texting not paused, for the chat to reach any workspace. One number that isn't, and
 *   the chat is answered from its home alone.
 * - **No chat is bound to a workspace** ("Tex, use @slug" and the choose-a-workspace prompt are gone). Its reach is
 *   every shared workspace all its account holders are live members of, worked out each turn and re-read on every
 *   request (`lib/textGroupReach.ts`): the grant is minted on the pinned workspace for the chat's sponsor, carries
 *   `texGroup.reach`, and a tool call names one workspace by `context: "@slug"`. Never a personal workspace, never the
 *   pin, and at the lowest role among the chat's people.
 * - **The grant reads at team tier and names nobody.** No `context:private`, no granted names in reach, and a note any
 *   one of them couldn't open is not reachable, whoever tagged Tex.
 * - The person who tagged Tex is the acting identity for their own accounts; every turn is metered to the sponsor.
 * - **Homes, not guest mode** (the owner, 2026-10-31; `lib/textGroupHomeOnly.ts`): a guest who tags Tex is answered
 *   from the chat's home in the pinned workspace. Guest mode (2026-10-25) is retired.
 * - **Invited family** (the owner, 2026-10-27; `lib/textGroupInvited.ts`):
 *   "Tex, add everyone here to @slug" from an owner of a shared workspace
 *   invites each person in the chat by number, and a pending phone invitation
 *   counts as membership in the chat, so it works on the whole workspace. This is the one thing that still names a
 *   workspace for a chat (`textGroups.workspaceId`, deprecated otherwise).
 *
 * The participant list is never stored: it arrives with each message (the
 * Worker sends the union of the webhook's list and Sendblue's own), and is
 * resolved again each time. The chat is named by a hash of its line and id.
 */

export const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
export const TEXTS_GROUP_CLIENT_NAME = "Tex (group chats)";
/** A group grant only has to outlast one answer, like a text's. */
export const TEXTS_GROUP_GRANT_TTL_MS = 15 * 60 * 1000;
/** Most people a chat may have for Tex to answer in it. Sendblue's groups take 25. */
export const MAX_GROUP_PARTICIPANTS = 32;
/** The longest workspace slug a command may name. */
const MAX_SLUG = 64;

/** How much Tex joins in a group (`textGroups.engagement`); the contract's closed set. */
export const ENGAGEMENT_STYLES = ["quiet", "attentive", "followAlong", "helpful"] as const;
export type Engagement = (typeof ENGAGEMENT_STYLES)[number];
const engagementValidator = v.union(v.literal("quiet"), v.literal("attentive"), v.literal("followAlong"), v.literal("helpful"));

/** What the Worker is told about a chat's style: the choice, whether anyone made one, and how Tex talks there (`lib/texStyle.ts`). */
function engagementOf(chat: Doc<"textGroups">): { engagement?: Engagement; engagementChosen: boolean; texStyle?: TexStyle } {
  const talk = hasTexStyle(chat.texStyle) ? { texStyle: chat.texStyle } : {};
  return chat.engagement === undefined ? { engagementChosen: false, ...talk } : { engagement: chat.engagement, engagementChosen: true, ...talk };
}

const commandValidator = v.union(
  v.object({ kind: v.literal("stop") }),
  v.object({ kind: v.literal("start") }),
  v.object({ kind: v.literal("invite"), slug: v.string(), role: v.optional(v.union(v.literal("editor"), v.literal("member"))) }),
  v.object({ kind: v.literal("share_mail"), address: v.string(), query: v.optional(v.string()) }),
  v.object({ kind: v.literal("unshare_mail"), address: v.optional(v.string()) }),
);

export const groupAnswerValidator = v.union(
  v.object({ status: v.literal("refused") }),
  v.object({ status: v.literal("muted") }),
  v.object({ status: v.literal("stopped") }),
  v.object({ status: v.literal("started") }),
  v.object({ status: v.literal("unknown_sender"), tell: v.boolean() }),
  v.object({ status: v.literal("no_shared") }),
  /** "Tex, add everyone here to @slug" from someone who isn't an owner there, or a name no workspace has: one answer. */
  v.object({ status: v.literal("not_allowed"), slug: v.string() }),
  /** "Tex, add everyone here to @slug": how many people here were invited, as what (`lib/textGroupInvited.ts`). */
  v.object({ status: v.literal("invited"), slug: v.string(), count: v.number(), role: v.string() }),
  /** A mailbox shared with the chat, or the sender's shares ended (`lib/textGroupMail.ts`); refused is one answer for every reason. */
  v.object({ status: v.literal("mail_shared"), address: v.string(), narrowed: v.boolean() }),
  v.object({ status: v.literal("mail_unshared"), count: v.number() }),
  v.object({ status: v.literal("mail_refused") }),
  v.object({
    status: v.literal("ready"),
    slug: v.string(),
    intro: v.boolean(),
    /** Deprecated: always false. A chat is no longer bound to a workspace (2026-10-31). */
    bound: v.boolean(),
    /** The slugs of the shared workspaces the chat reaches this turn, by name: none when anyone here has no account. */
    reach: v.optional(v.array(v.string())),
    timeZone: v.string(),
    /** The tagger's handle (their personal workspace's slug), so the answer can say who asked; "" when none. */
    handle: v.string(),
    /** False when only a command was asked: no token was minted. */
    minted: v.boolean(),
    /** Each person in the chat's handle, so what they said before the tag is filed by name, never by number. */
    names: v.array(v.object({ phone: v.string(), handle: v.string() })),
    /**
     * A label for each person with no account (or who isn't a member of the workspace the answer names), and the
     * tagger's label when they are one of them. A guest never appears in `names`, so an email is never offered to go
     * from a guest's account. Guest mode itself is retired (`lib/textGroupGuests.ts`).
     */
    guests: v.optional(v.array(v.object({ phone: v.string(), label: v.string() }))),
    guestTagger: v.optional(v.string()),
    /** The chat's style, absent until someone in it chose one (`engagementChosen` false). */
    engagement: v.optional(engagementValidator),
    engagementChosen: v.boolean(),
    texStyle: v.optional(texStyleValidator),
    /** Mailboxes shared with this chat, by whose and which address, for the turn to be told (`lib/textGroupMail.ts`). */
    mail: v.optional(v.array(v.object({ handle: v.string(), address: v.string() }))),
  }),
);

export type GroupAnswer =
  | { status: "refused" | "muted" | "stopped" | "started" | "no_shared" }
  | { status: "not_allowed"; slug: string }
  | { status: "invited"; slug: string; count: number; role: string }
  | { status: "mail_shared"; address: string; narrowed: boolean }
  | { status: "mail_unshared"; count: number }
  | { status: "mail_refused" }
  | { status: "unknown_sender"; tell: boolean }
  | {
      status: "ready";
      slug: string;
      intro: boolean;
      bound: boolean;
      reach?: string[];
      timeZone: string;
      handle: string;
      minted: boolean;
      names: { phone: string; handle: string }[];
      guests?: { phone: string; label: string }[];
      guestTagger?: string;
      engagement?: Engagement;
      engagementChosen: boolean;
      texStyle?: TexStyle;
    };

/** The key a chat is filed under: its line and Sendblue id, hashed, never stored as given. */
export async function groupKeyOf(line: string, groupId: string): Promise<string> {
  return await hashToken(`${line}:${groupId}`);
}

/**
 * One tagged message in a group, or one command. Mints a grant (the hashes
 * given) only when the answer is `ready` and `mint` is set.
 */
export const applyGroupTurn = internalMutation({
  args: {
    line: v.string(),
    groupKey: v.string(),
    sender: v.string(),
    participants: v.array(v.string()),
    command: v.optional(commandValidator),
    mint: v.boolean(),
    /** A routine's or check-in's own run: not somebody talking, so the chat's last word stays when it was. */
    routine: v.optional(v.boolean()),
    hashedAccessToken: v.string(),
    hashedRefreshToken: v.string(),
    expiresAt: v.number(),
  },
  returns: groupAnswerValidator,
  handler: async (ctx, args): Promise<GroupAnswer> => {
    if (!isPhoneNumber(args.line) || !isPhoneNumber(args.sender) || !/^[0-9a-f]{64}$/.test(args.groupKey)) {
      return { status: "refused" };
    }
    if (args.participants.length === 0 || args.participants.length > MAX_GROUP_PARTICIPANTS) return { status: "refused" };
    // Only the line this message came in on is Tex. Any other entry, another
    // of our lines included, is a participant like anyone else.
    const others = [...new Set(args.participants.filter((phone) => phone !== args.line))];
    if (!others.includes(args.sender)) return { status: "refused" };

    const now = Date.now();
    const group = await groupRow(ctx, args.groupKey, now, args.routine !== true);
    const senderUser = await linkedUser(ctx, args.sender);

    // Anyone in the chat may stop Tex or start it again: it cannot leave a group.
    if (args.command?.kind === "stop") {
      await muteChat(ctx, group, senderUser, now);
      return { status: "stopped" };
    }
    if (args.command?.kind === "start") {
      await unmuteChat(ctx, group);
      return { status: "started" };
    }
    if (group.mutedAt !== undefined) return { status: "muted" };
    // A bound chat checks in on its own, as a person's Tex does; any word here arms it (`lib/textGroupLooks.ts`).
    await armChatLook(ctx, group, now);

    // "Tex, share my mail from me@work.example here" (`lib/textGroupMail.ts`): only the mailbox's own person.
    if (args.command?.kind === "share_mail") {
      const address = cleanAddress(args.command.address);
      const query = cleanShareQuery(args.command.query);
      const shared = senderUser === null || address === null || query === null ? null : await shareMail(ctx, group, senderUser, address, query, now);
      return shared === null ? { status: "mail_refused" } : { status: "mail_shared", ...shared };
    }
    if (args.command?.kind === "unshare_mail") {
      const address = args.command.address === undefined ? undefined : cleanAddress(args.command.address) ?? "";
      return { status: "mail_unshared", count: senderUser === null ? 0 : await unshareMail(ctx, group, senderUser, address) };
    }

    // "Tex, add everyone here to @slug" (`lib/textGroupInvited.ts`): only an owner there, and then the chat uses it.
    if (args.command?.kind === "invite") {
      const slug = cleanSlug(args.command.slug);
      const role = args.command.role ?? "editor";
      const added = senderUser === null ? null : await inviteEveryone(ctx, senderUser, slug, others, role);
      if (added === null || senderUser === null) return { status: "not_allowed", slug };
      await clearGuests(ctx, group);
      await ctx.db.patch(group._id, { workspaceId: added.workspace._id, boundBy: senderUser });
      return { status: "invited", slug: added.workspace.slug, count: added.count, role };
    }

    // A chat an owner added everyone to ("Tex, add everyone here to @slug", `textGroupInvited.ts`) whose people are all
    // members or invited there works on that whole workspace. Every other chat is answered by its reach, below.
    const counted = group.workspaceId !== undefined ? await ctx.db.get(group.workspaceId) : null;
    const invited = counted === null ? null : await invitedChat(ctx, counted, others, now);
    // A guest chat (retired, E2) answers from its home, as any chat with people who aren't all here shares a workspace.
    if (group.guestGroupId !== undefined) {
      const answer = invited === null || invited.invited.size === 0 ? null : await invitedTurn(ctx, args, group, invited);
      if (invited === null || (answer === null && invited.invited.size > 0)) return (await homeAnswer(ctx, args, group, senderUser, others)) ?? { status: "no_shared" };
      await clearGuests(ctx, group);
      if (answer !== null) return answer;
    }
    if (invited !== null && invited.invited.size > 0) {
      const fresh = (await ctx.db.get(group._id)) ?? group;
      const answer = await invitedTurn(ctx, args, fresh, invited);
      if (answer !== null) return answer;
    }

    // A guest who tags Tex, with no account, is answered from the chat's home (E1, `lib/textGroupHomeOnly.ts`): the
    // chat's sponsor pays and the grant reads only the home. A routine or a command is never a guest's to ask.
    if (senderUser === null && args.command === undefined && args.routine !== true) {
      const answer = await homeAnswer(ctx, args, group, null, others);
      if (answer !== null) return answer;
    }
    if (senderUser === null) {
      // Told once per person per chat, and by a salted hash, never the number.
      const told = new Set(group.toldUnknown ?? []);
      const mark = await hashToken(`${args.groupKey}:${args.sender}`);
      const tell = !told.has(mark);
      if (tell) await ctx.db.patch(group._id, { toldUnknown: [...told, mark].slice(-MAX_GROUP_PARTICIPANTS) });
      return { status: "unknown_sender", tell };
    }

    // Everyone else is answered from the chat's home, on a grant that also reaches the shared workspaces all its account
    // holders share (`lib/textGroupReach.ts`): none when anyone here has no account. A routine is nobody talking, and
    // runs only where there is a workspace to run in.
    const answer = await homeAnswer(ctx, args, group, senderUser, others);
    // A deployment with no pinned workspace has no home to answer from: its chat works on the one workspace in its reach.
    if (answer === null) return (await pinnedContextWorkspace(ctx)) === null ? await singleWorkspaceTurn(ctx, args, group, senderUser, others) : { status: "no_shared" };
    if (args.routine === true && answer.status === "ready" && (answer.reach ?? []).length === 0) return { status: "no_shared" };
    return answer;
  },
});

type TurnArgs = {
  groupKey: string;
  sender: string;
  command?: Infer<typeof commandValidator>;
  mint: boolean;
  hashedAccessToken: string;
  hashedRefreshToken: string;
  expiresAt: number;
};

/**
 * A tag in a chat answered from its home (E1, decided by the owner, 2026-10-31; `lib/textGroupHomeOnly.ts`): its people
 * are named on the home, and the grant reads that home alone in the pin. Null when the chat can't be answered this way
 * (no pin on this deployment, or nobody who may pay), and the caller answers as it did before.
 */
async function homeAnswer(
  ctx: MutationCtx,
  args: TurnArgs,
  chat: Doc<"textGroups">,
  senderUser: Id<"users"> | null,
  others: string[],
): Promise<GroupAnswer | null> {
  const turn = await homeOnlyTurn(ctx, args, chat, senderUser, others);
  if (turn === null) return null;
  return { status: "ready", ...turn, bound: false, ...engagementOf(chat), ...(await mailSharesNamed(ctx, chat._id)) };
}

/**
 * A deployment with no pinned workspace has no home to put a chat's grant on, so the chat is answered as it was before
 * reach: on the one workspace in its reach (`chatWorkspace`'s rule: the one it was last bound to if still in reach,
 * else the first by name), at team tier, for the tagger. Self-hosting needs this (`CLAUDE.md`: a working context without
 * us), and it widens nothing: the grant reads that one workspace while every person is a member of it
 * (`lib/controlPlane/liveGrants.ts` `groupStillShares`). Nothing is asked of the chat: there is no "use @slug".
 */
async function singleWorkspaceTurn(
  ctx: MutationCtx,
  args: TurnArgs,
  group: Doc<"textGroups">,
  senderUser: Id<"users">,
  others: string[],
): Promise<GroupAnswer> {
  const users: Id<"users">[] = [];
  const phones = new Map<Id<"users">, string>();
  for (const phone of others) {
    const userId = phone === args.sender ? senderUser : await linkedUser(ctx, phone);
    if (userId === null) return { status: "no_shared" };
    phones.set(userId, phone);
    if (!users.includes(userId)) users.push(userId);
  }
  const reach = await reachOf(ctx, group, users);
  const workspace = (reach.find((row) => row.workspace._id === group.workspaceId) ?? reach[0])?.workspace;
  if (workspace === undefined) return { status: "no_shared" };
  if (group.workspaceId !== workspace._id) await ctx.db.patch(group._id, { workspaceId: workspace._id, boundBy: senderUser });
  const intro = group.introducedAt === undefined;
  const minted = args.mint && args.command === undefined;
  if (minted) {
    const ok = await mintGroupGrant(ctx, {
      group,
      workspaceId: workspace._id,
      tagger: senderUser,
      coViewerIds: users.filter((userId) => userId !== senderUser),
      people: users,
      hashedAccessToken: args.hashedAccessToken,
      hashedRefreshToken: args.hashedRefreshToken,
      expiresAt: args.expiresAt,
      participants: others.length,
    });
    if (!ok) return { status: "no_shared" };
  }
  const introduced = intro && minted;
  if (introduced) await ctx.db.patch(group._id, { introducedAt: Date.now() });
  const names: { phone: string; handle: string }[] = [];
  for (const [userId, phone] of phones) names.push({ phone, handle: await handleOf(ctx, userId) });
  const timeZone = effectiveTimeZone(undefined, await accountTimeZone(ctx, senderUser));
  const handle = await handleOf(ctx, senderUser);
  return { status: "ready", slug: workspace.slug, intro: introduced, bound: false, reach: [workspace.slug], timeZone, handle, minted, names, ...engagementOf(group), ...(await mailSharesNamed(ctx, group._id)) };
}

/** A slug as a command said it: no "@", lowercase, bounded. */
function cleanSlug(said: string): string {
  return said.trim().replace(/^@/, "").toLowerCase().slice(0, MAX_SLUG);
}

/**
 * One tag in a chat whose people are members of the workspace or invited there by number (`lib/textGroupInvited.ts`). The grant reads at team tier, as any chat's does. It is the tagger's own when they are a
 * member, and otherwise the binder's, an owner or editor in the chat, clamped to the invitation's role and marked so
 * it acts for nobody's own account. Null when it can't answer this way and the chat goes on as before: nobody here
 * who may stand behind an invited person's tag.
 */
async function invitedTurn(
  ctx: MutationCtx,
  args: TurnArgs,
  chat: Doc<"textGroups">,
  invited: InvitedChat,
): Promise<GroupAnswer | null> {
  const workspace = invited.workspace;
  const taggerUser = invited.members.get(args.sender) ?? null;
  let actor = taggerUser;
  const taggerInvitation = invited.invited.get(args.sender);
  if (actor === null) {
    const binder = chat.workspaceId === workspace._id ? chat.boundBy : undefined;
    const inChat = binder !== undefined && [...invited.members.values()].includes(binder);
    if (!inChat || !(await mayOpenToGuests(ctx, workspace._id, binder)) || (await phoneSignInPaused(ctx, binder))) return null;
    actor = binder;
  }
  const minted = args.mint && args.command === undefined;
  if (minted) {
    const ok = await mintGroupGrant(ctx, {
      group: chat,
      workspaceId: workspace._id,
      tagger: actor,
      coViewerIds: [...new Set(invited.members.values())].filter((userId) => userId !== actor),
      people: [...invited.members.values()],
      hashedAccessToken: args.hashedAccessToken,
      hashedRefreshToken: args.hashedRefreshToken,
      expiresAt: args.expiresAt,
      participants: invited.members.size + invited.invited.size,
      invited: {
        invitationIds: [...invited.invited.values()].map((row) => row._id),
        ...(taggerInvitation !== undefined ? { taggerRole: taggerInvitation.role } : {}),
      },
    });
    if (!ok) return null;
  }
  const introduced = chat.introducedAt === undefined && minted;
  if (introduced) await ctx.db.patch(chat._id, { introducedAt: Date.now() });
  const names: { phone: string; handle: string }[] = [];
  for (const [phone, userId] of invited.members) names.push({ phone, handle: await handleOf(ctx, userId) });
  // An invited person is named by a label, never by number, as a guest is.
  const guests: { phone: string; label: string }[] = [];
  for (const phone of invited.invited.keys()) guests.push({ phone, label: await guestLabel(args.groupKey, phone) });
  const timeZone = effectiveTimeZone(undefined, await accountTimeZone(ctx, actor));
  const handle = taggerUser !== null ? await handleOf(ctx, taggerUser) : "";
  const tagger = taggerUser !== null ? {} : { guestTagger: await guestLabel(args.groupKey, args.sender) };
  return { status: "ready", slug: workspace.slug, intro: introduced, bound: false, reach: [workspace.slug], timeZone, handle, minted, names, guests, ...tagger, ...engagementOf(chat), ...(await mailSharesNamed(ctx, chat._id)) };
}

async function groupRow(ctx: MutationCtx, groupKey: string, now: number, touch: boolean): Promise<Doc<"textGroups">> {
  const existing = await ctx.db
    .query("textGroups")
    .withIndex("by_key", (q) => q.eq("groupKey", groupKey))
    .unique();
  if (existing !== null && !touch) return existing;
  if (existing !== null) {
    await ctx.db.patch(existing._id, { lastSeenAt: now });
    return { ...existing, lastSeenAt: now };
  }
  const id = await ctx.db.insert("textGroups", { groupKey, lastSeenAt: now });
  return (await ctx.db.get(id))!;
}

async function mintGroupGrant(
  ctx: MutationCtx,
  input: {
    group: Doc<"textGroups">;
    workspaceId: Id<"workspaces">;
    tagger: Id<"users">;
    coViewerIds: Id<"users">[];
    /** Everyone in the chat with an account, the tagger included: whom the chat's home names (`textGroupHome.ts`). */
    people: Id<"users">[];
    hashedAccessToken: string;
    hashedRefreshToken: string;
    expiresAt: number;
    participants: number;
    /** Invited family (`lib/textGroupInvited.ts`): the invitations counted, and the invited tagger's role when one tagged. */
    invited?: { invitationIds: Id<"workspaceInvitations">[]; taggerRole?: "editor" | "member" };
  },
): Promise<boolean> {
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", input.workspaceId).eq("userId", input.tagger))
    .unique();
  if (membership === null) return false;
  // Never `context:private`: a group reads at team tier whoever tagged Tex.
  // An invited person's tag acts through the binder, and never past the invitation's role.
  const taggerRole = input.invited?.taggerRole;
  const scopes = clampScopes(clampScopes([SCOPE_READ, SCOPE_WRITE], membership.role), taggerRole ?? membership.role);
  if (!hasOperationScope(scopes)) return false;
  // Every turn in the chat is metered to its sponsor, who brought Tex in, whoever tagged it (the owner, 2026-10-31).
  // The sponsor is set once, here, when the row has none (`lib/textGroupUsage.ts`).
  const fresh = (await ctx.db.get(input.group._id)) ?? input.group;
  const sponsor = sponsorOf(fresh, input.tagger);
  const sponsorMeter = (await phoneSignInPaused(ctx, sponsor)) ? null : await personalWorkspaceOf(ctx, sponsor);
  // The sponsor has no personal workspace, or texting is paused for them: keep today's meter, the tagger's.
  const meterWorkspaceId = sponsorMeter ?? (await personalWorkspaceOf(ctx, input.tagger));
  if (meterWorkspaceId === null) return false;
  await ensureGroupClient(ctx, TEXTS_GROUP_CLIENT_ID, TEXTS_GROUP_CLIENT_NAME);

  const invited =
    input.invited === undefined
      ? {}
      : { coInvitationIds: input.invited.invitationIds, ...(taggerRole !== undefined ? { invitedTaggerRole: taggerRole } : {}) };
  const texGroup = { groupId: input.group._id, coViewerIds: input.coViewerIds, meterWorkspaceId, ...invited };
  const token = {
    scopes,
    texGroup,
    hashedRefreshToken: input.hashedRefreshToken,
    hashedAccessToken: input.hashedAccessToken,
    accessTokenExpiresAt: input.expiresAt,
  };
  // One live grant per person per chat: a new turn's token replaces the last.
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", input.workspaceId).eq("userId", input.tagger))
    .collect();
  const reusable = grants.find(
    (grant) => grant.clientId === TEXTS_GROUP_CLIENT_ID && grant.status === "active" && grant.texGroup?.groupId === input.group._id,
  );
  if (reusable === undefined) {
    await ctx.db.insert("oauthGrants", {
      workspaceId: input.workspaceId,
      userId: input.tagger,
      clientId: TEXTS_GROUP_CLIENT_ID,
      ...token,
      status: "active",
      createdAt: Date.now(),
    });
  } else {
    await ctx.db.patch(reusable._id, token);
  }
  if (fresh.sponsorId === undefined) await ctx.db.patch(input.group._id, { sponsorId: sponsor });
  await ensureChatHome(ctx, input.group, input.people, input.tagger);
  await recordAudit(ctx, {
    workspaceId: input.workspaceId,
    actorUserId: input.tagger,
    actorClientId: TEXTS_GROUP_CLIENT_ID,
    action: "texts.group.session.opened",
    details: {
      scopes: scopes.join(" "),
      participants: input.participants,
      ...(input.invited !== undefined ? { invited: input.invited.invitationIds.length, invitedTagger: taggerRole !== undefined } : {}),
    },
  });
  return true;
}

/**
 * A group's style, chosen by someone in it (contract section 4). Only for a chat Tex already has a row for: a choice
 * never creates one. A number given as `setBy` is kept only as a `groupKey`-salted hash, like `toldUnknown`.
 */
export const setGroupEngagement = internalMutation({
  args: { groupKey: v.string(), style: engagementValidator, setBy: v.string() },
  returns: v.union(v.literal("set"), v.literal("unknown")),
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("textGroups")
      .withIndex("by_key", (q) => q.eq("groupKey", args.groupKey))
      .unique();
    if (chat === null) return "unknown";
    const setBy = isPhoneNumber(args.setBy) ? await hashToken(`${args.groupKey}:${args.setBy}`) : args.setBy;
    await setChatEngagement(ctx, chat, args.style, setBy);
    return "set";
  },
});

/** The workspace a decision is metered against: a group's one workspace in reach (`chatWorkspace`), or null when it has none. */
export const groupDecideWorkspace = internalQuery({
  args: { groupKey: v.string() },
  returns: v.union(v.id("workspaces"), v.null()),
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("textGroups")
      .withIndex("by_key", (q) => q.eq("groupKey", args.groupKey))
      .unique();
    if (chat === null) return null;
    const reached = await chatWorkspace(ctx, chat);
    if (reached !== null) return reached._id;
    // A chat that reaches no shared workspace (a home-only chat, 2026-11-01) is metered to its sponsor, as its turns are
    // (`lib/textGroupUsage.ts`); without this every decide there was refused as no_group and untagged texts went unjudged.
    const sponsor = chat.sponsorId ?? chat.boundBy;
    return sponsor === undefined ? null : await personalWorkspaceOf(ctx, sponsor);
  },
});
