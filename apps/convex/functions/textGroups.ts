import { v, type Infer } from "convex/values";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { phoneSignInPaused } from "./lib/emailProof";
import { recordAudit } from "./lib/audit";
import { SCOPE_READ, SCOPE_WRITE, clampScopes, hasOperationScope } from "./lib/consentScopes";
import { hashToken } from "./lib/crypto";
import { accountTimeZone } from "./lib/routines/access";
import { effectiveTimeZone } from "./lib/routines/model";
import { isPhoneNumber, personalWorkspaceOf } from "./textLinks";
import { getMembership } from "./lib/workspaceAuth";
import { syncChatPeople } from "./lib/textGroupGuestSync";
import { bindGuestChat, clearGuests, ensureChatFolderGrant, guestBinder, guestLabel, guestOf, mayOpenToGuests, type GuestInfo } from "./lib/textGroupGuests";
import { inviteEveryone, invitedChat, workspaceBySlug, type InvitedChat } from "./lib/textGroupInvited";
import { cleanAddress, cleanShareQuery, mailSharesNamed, shareMail, unshareMail } from "./lib/textGroupMail";

/**
 * Tex in an iMessage group chat: who is in it, and which one workspace it may use.
 *
 * Decided by the owner on 2026-10-20 (`docs/decisions/texting-assistant/groups.md`):
 *
 * - **Everyone counts, or nobody does.** Every participant but the line the
 *   message arrived on must be a phone linked by code (`phoneLinks`), with
 *   texting not paused. One number that isn't, and the chat reaches no notes.
 * - **One shared workspace per chat.** It must be a shared workspace every one
 *   of them is a live member of. When they share one, it is used; when they
 *   share several, the chat picks one ("Tex, use @slug") and the choice stays
 *   until the chat changes it or it stops being shared by everyone.
 * - **The grant reads at team tier and names nobody.** No `context:private`,
 *   no granted names, nothing but its own workspace (`liveGrants.ts`), and it
 *   resolves only while every co-viewer is still a member. So a note any one
 *   of them couldn't open is not reachable, whoever tagged Tex.
 * - The person who tagged Tex is the acting identity: their role decides
 *   writes, their personal workspace is metered, and the audit names them.
 * - **Guest mode** (the owner, 2026-10-25; `lib/textGroupGuests.ts`): "Tex,
 *   use @slug" from an owner or editor of a workspace not everyone here
 *   shares gives the chat a group and folder of its own there. Then anyone in
 *   the chat may tag Tex, accounts or not, and the grant reads only what is
 *   shared with that group; usage counts against whoever turned it on.
 * - **Invited family** (the owner, 2026-10-27; `lib/textGroupInvited.ts`):
 *   "Tex, add everyone here to @slug" from an owner of a shared workspace
 *   invites each person in the chat by number, and a pending phone invitation
 *   counts as membership in the chat, so it works on the whole workspace.
 *
 * The participant list is never stored: it arrives with each message (the
 * Worker sends the union of the webhook's list and Sendblue's own), and is
 * resolved again each time. The chat is named by a hash of its line and id.
 * A guest chat writes who is in it only as accounts: group rows and folder
 * grantees (`lib/textGroupGuestSync.ts`), never a phone number.
 */

export const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
export const TEXTS_GROUP_CLIENT_NAME = "Tex (group chats)";
/** A group grant only has to outlast one answer, like a text's. */
export const TEXTS_GROUP_GRANT_TTL_MS = 15 * 60 * 1000;
/** Most people a chat may have for Tex to answer in it. Sendblue's groups take 25. */
export const MAX_GROUP_PARTICIPANTS = 32;
/** Most workspaces read per person when intersecting; nobody is in this many. */
const MEMBERSHIP_SCAN = 200;
/** The longest workspace slug a command may name. */
const MAX_SLUG = 64;

const commandValidator = v.union(
  v.object({ kind: v.literal("stop") }),
  v.object({ kind: v.literal("start") }),
  v.object({ kind: v.literal("use"), slug: v.string() }),
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
  /** `slugs`: the workspaces everyone here does share, so the answer can name them (2026-10-21). */
  v.object({ status: v.literal("not_shared"), slugs: v.array(v.string()) }),
  v.object({ status: v.literal("choose"), slugs: v.array(v.string()) }),
  /** "Tex, use @slug" from someone who isn't an owner or editor there, or a name no workspace has: one answer. */
  v.object({ status: v.literal("not_allowed"), slug: v.string() }),
  /** A guest chat whose group is gone or whose binder can no longer open it: guest mode is off. */
  v.object({ status: v.literal("guests_off") }),
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
    bound: v.boolean(),
    timeZone: v.string(),
    /** The tagger's handle (their personal workspace's slug), so the answer can say who asked; "" when none. */
    handle: v.string(),
    /** False when only the binding was asked for ("Tex, use @slug"): no token was minted. */
    minted: v.boolean(),
    /** Each person in the chat's handle, so what they said before the tag is filed by name, never by number. */
    names: v.array(v.object({ phone: v.string(), handle: v.string() })),
    /**
     * Guest mode (`lib/textGroupGuests.ts`): the chat's group and folder, a label for each person who isn't a member
     * of the workspace, and the tagger's label when they are one of them. A guest never appears in `names`, so an
     * email is never offered to go from a guest's account.
     */
    guest: v.optional(v.object({ group: v.string(), words: v.string(), folder: v.string() })),
    guests: v.optional(v.array(v.object({ phone: v.string(), label: v.string() }))),
    guestTagger: v.optional(v.string()),
    /** Mailboxes shared with this chat, by whose and which address, for the turn to be told (`lib/textGroupMail.ts`). */
    mail: v.optional(v.array(v.object({ handle: v.string(), address: v.string() }))),
  }),
);

export type GroupAnswer =
  | { status: "refused" | "muted" | "stopped" | "started" | "no_shared" | "guests_off" }
  | { status: "not_shared"; slugs: string[] }
  | { status: "not_allowed"; slug: string }
  | { status: "invited"; slug: string; count: number; role: string }
  | { status: "mail_shared"; address: string; narrowed: boolean }
  | { status: "mail_unshared"; count: number }
  | { status: "mail_refused" }
  | { status: "unknown_sender"; tell: boolean }
  | { status: "choose"; slugs: string[] }
  | {
      status: "ready";
      slug: string;
      intro: boolean;
      bound: boolean;
      timeZone: string;
      handle: string;
      minted: boolean;
      names: { phone: string; handle: string }[];
      guest?: GuestInfo;
      guests?: { phone: string; label: string }[];
      guestTagger?: string;
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
    const group = await groupRow(ctx, args.groupKey, now);
    const senderUser = await linkedUser(ctx, args.sender);

    // Anyone in the chat may stop Tex or start it again: it cannot leave a group.
    if (args.command?.kind === "stop") {
      await ctx.db.patch(group._id, { mutedAt: now, ...(senderUser !== null ? { mutedBy: senderUser } : {}) });
      return { status: "stopped" };
    }
    if (args.command?.kind === "start") {
      await ctx.db.patch(group._id, { mutedAt: undefined, mutedBy: undefined });
      return { status: "started" };
    }
    if (group.mutedAt !== undefined) return { status: "muted" };

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

    // A guest chat answers whoever tags it, accounts or not, until "use" names a workspace everyone shares.
    if (args.command?.kind !== "use" && group.guestGroupId !== undefined) return await guestTurn(ctx, args, group, senderUser, others);

    // A chat whose people are all members or invited there by number works on the whole workspace (`textGroupInvited.ts`).
    const usingSlug = args.command?.kind === "use" ? cleanSlug(args.command.slug) : null;
    const counted = usingSlug !== null ? await workspaceBySlug(ctx, usingSlug) : group.workspaceId !== undefined ? await ctx.db.get(group.workspaceId) : null;
    const invited = counted === null ? null : await invitedChat(ctx, counted, others, now);
    if (invited !== null && invited.invited.size > 0) {
      const fresh = (await ctx.db.get(group._id)) ?? group;
      const answer = await invitedTurn(ctx, args, fresh, invited, usingSlug !== null);
      if (answer !== null) return answer;
    }

    // Somebody with no account can't open a workspace to anyone; in a guest chat they are told so plainly.
    if (senderUser === null && args.command?.kind === "use" && group.guestGroupId !== undefined) {
      return { status: "not_allowed", slug: cleanSlug(args.command.slug) };
    }
    if (senderUser === null) {
      // Told once per person per chat, and by a salted hash, never the number.
      const told = new Set(group.toldUnknown ?? []);
      const mark = await hashToken(`${args.groupKey}:${args.sender}`);
      const tell = !told.has(mark);
      if (tell) await ctx.db.patch(group._id, { toldUnknown: [...told, mark].slice(-MAX_GROUP_PARTICIPANTS) });
      return { status: "unknown_sender", tell };
    }

    const users: Id<"users">[] = [];
    const phones = new Map<Id<"users">, string>();
    let everyone = true;
    for (const phone of others) {
      const userId = phone === args.sender ? senderUser : await linkedUser(ctx, phone);
      if (userId === null) {
        everyone = false;
        break;
      }
      phones.set(userId, phone);
      if (!users.includes(userId)) users.push(userId);
    }
    const shared = everyone ? await sharedWorkspaces(ctx, users) : [];

    let bound = false;
    let workspace = shared.find((entry) => entry._id === group.workspaceId) ?? null;
    if (args.command?.kind === "use") {
      const slug = cleanSlug(args.command.slug);
      const chosen = shared.find((entry) => entry.slug === slug) ?? null;
      if (chosen === null) {
        // Guest mode (`lib/textGroupGuests.ts`): an owner or editor opens that workspace to this chat, whoever is in it.
        const opened = await bindGuestChat(ctx, group, senderUser, slug);
        // Every person here is a member of each of these, so naming them tells nobody anything new.
        if (opened === null) return shared.length > 0 ? { status: "not_shared", slugs: shared.map((entry) => entry.slug).sort() } : { status: "not_allowed", slug };
        const fresh = await ctx.db.get(group._id);
        return fresh === null ? { status: "refused" } : await guestTurn(ctx, args, fresh, senderUser, others, opened.changed);
      }
      // A workspace everyone shares: an ordinary chat again, at its team tier.
      bound = chosen._id !== group.workspaceId || group.guestGroupId !== undefined;
      await clearGuests(ctx, group);
      workspace = chosen;
    } else if (!everyone || shared.length === 0) {
      return { status: "no_shared" };
    } else if (workspace === null) {
      if (shared.length > 1) return { status: "choose", slugs: shared.map((entry) => entry.slug).sort() };
      workspace = shared[0];
      bound = true;
    }
    if (bound) await ctx.db.patch(group._id, { workspaceId: workspace._id, boundBy: senderUser });

    const intro = group.introducedAt === undefined;
    const timeZone = effectiveTimeZone(undefined, await accountTimeZone(ctx, senderUser));
    const minted = args.mint && args.command === undefined;
    if (minted) {
      const ok = await mintGroupGrant(ctx, {
        group,
        workspaceId: workspace._id,
        tagger: senderUser,
        coViewerIds: users.filter((userId) => userId !== senderUser),
        hashedAccessToken: args.hashedAccessToken,
        hashedRefreshToken: args.hashedRefreshToken,
        expiresAt: args.expiresAt,
        participants: others.length,
      });
      if (!ok) return { status: "no_shared" };
    }
    // Choosing the workspace is the chat's first word from Tex, so the line that answers it carries the introduction.
    const introduced = intro && (minted || args.command?.kind === "use");
    if (introduced) await ctx.db.patch(group._id, { introducedAt: now });
    const names: { phone: string; handle: string }[] = [];
    for (const [userId, phone] of phones) names.push({ phone, handle: await handleOf(ctx, userId) });
    const handle = await handleOf(ctx, senderUser);
    const mail = await mailSharesNamed(ctx, (await ctx.db.get(group._id)) ?? group);
    return { status: "ready", slug: workspace.slug, intro: introduced, bound, timeZone, handle, minted, names, ...(mail.length > 0 ? { mail } : {}) };
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
 * One tag, or the "use" that turned guest mode on, in a guest chat (`lib/textGroupGuests.ts`). The grant reads only
 * what is shared with the chat's group (`lib/controlPlane/liveGrants.ts`), whoever tagged Tex. It is the tagger's own
 * when they are a member of the workspace, and otherwise the binder's, marked as a guest's, so it acts for nobody's
 * own account. Usage counts against the binder either way.
 */
async function guestTurn(
  ctx: MutationCtx,
  args: TurnArgs,
  chat: Doc<"textGroups">,
  senderUser: Id<"users"> | null,
  others: string[],
  justBound = false,
): Promise<GroupAnswer> {
  const binder = await guestBinder(ctx, chat);
  const guest = await guestOf(ctx, chat);
  const workspace = chat.workspaceId === undefined ? null : await ctx.db.get(chat.workspaceId);
  if (binder === null || guest === null || workspace === null) {
    await clearGuests(ctx, chat);
    return { status: "guests_off" };
  }
  await ensureChatFolderGrant(ctx, chat, binder);
  const names: { phone: string; handle: string }[] = [];
  const guests: { phone: string; label: string }[] = [];
  const people = { members: [] as Id<"users">[], outsiders: [] as Id<"users">[] };
  let taggerMember = false;
  for (const phone of others) {
    const userId = phone === args.sender ? senderUser : await linkedUser(ctx, phone);
    if (userId !== null && (await getMembership(ctx, workspace._id, userId)) !== null) {
      names.push({ phone, handle: await handleOf(ctx, userId) });
      people.members.push(userId);
      if (phone === args.sender) taggerMember = true;
    } else {
      guests.push({ phone, label: await guestLabel(args.groupKey, phone) });
      if (userId !== null) people.outsiders.push(userId);
    }
  }
  // Who is here now, in the chat's group and on its folder (`lib/textGroupGuestSync.ts`).
  const current = await ctx.db.get(chat._id);
  if (current !== null) await syncChatPeople(ctx, current, binder, people);
  const actor = taggerMember && senderUser !== null ? senderUser : binder;
  const minted = args.mint && args.command === undefined;
  if (minted) {
    const ok = await mintGroupGrant(ctx, {
      group: chat,
      workspaceId: workspace._id,
      tagger: actor,
      coViewerIds: [],
      hashedAccessToken: args.hashedAccessToken,
      hashedRefreshToken: args.hashedRefreshToken,
      expiresAt: args.expiresAt,
      participants: others.length,
      guest: { groupId: guest.groupId, binder, guestTagger: !taggerMember },
    });
    if (!ok) return { status: "guests_off" };
  }
  const introduced = chat.introducedAt === undefined && (minted || args.command?.kind === "use");
  if (introduced) await ctx.db.patch(chat._id, { introducedAt: Date.now() });
  const timeZone = effectiveTimeZone(undefined, await accountTimeZone(ctx, actor));
  const tagger = taggerMember ? {} : { guestTagger: await guestLabel(args.groupKey, args.sender) };
  const handle = taggerMember ? await handleOf(ctx, actor) : "";
  return { status: "ready", slug: workspace.slug, intro: introduced, bound: justBound, timeZone, handle, minted, names, guest: guest.info, guests, ...tagger };
}

/** A slug as a command said it: no "@", lowercase, bounded. */
function cleanSlug(said: string): string {
  return said.trim().replace(/^@/, "").toLowerCase().slice(0, MAX_SLUG);
}

/**
 * One tag in a chat whose people are members of the workspace or invited there by number (`lib/textGroupInvited.ts`),
 * or the "use" that names it. The grant reads at team tier, as any chat's does. It is the tagger's own when they are a
 * member, and otherwise the binder's, an owner or editor in the chat, clamped to the invitation's role and marked so
 * it acts for nobody's own account. Null when it can't answer this way and the chat goes on as before: an invited
 * person saying "use", or nobody here who may stand behind an invited person's tag.
 */
async function invitedTurn(
  ctx: MutationCtx,
  args: TurnArgs,
  chat: Doc<"textGroups">,
  invited: InvitedChat,
  using: boolean,
): Promise<GroupAnswer | null> {
  const workspace = invited.workspace;
  const taggerUser = invited.members.get(args.sender) ?? null;
  if (using && taggerUser === null) return null;
  let actor = taggerUser;
  const taggerInvitation = invited.invited.get(args.sender);
  if (actor === null) {
    const binder = chat.workspaceId === workspace._id ? chat.boundBy : undefined;
    const inChat = binder !== undefined && [...invited.members.values()].includes(binder);
    if (!inChat || !(await mayOpenToGuests(ctx, workspace._id, binder)) || (await phoneSignInPaused(ctx, binder))) return null;
    actor = binder;
  }
  const bound = using && (chat.workspaceId !== workspace._id || chat.guestGroupId !== undefined);
  if (using) {
    await clearGuests(ctx, chat);
    await ctx.db.patch(chat._id, { workspaceId: workspace._id, boundBy: actor });
  }
  const minted = args.mint && args.command === undefined;
  if (minted) {
    const ok = await mintGroupGrant(ctx, {
      group: chat,
      workspaceId: workspace._id,
      tagger: actor,
      coViewerIds: [...new Set(invited.members.values())].filter((userId) => userId !== actor),
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
  const introduced = chat.introducedAt === undefined && (minted || using);
  if (introduced) await ctx.db.patch(chat._id, { introducedAt: Date.now() });
  const names: { phone: string; handle: string }[] = [];
  for (const [phone, userId] of invited.members) names.push({ phone, handle: await handleOf(ctx, userId) });
  // An invited person is named by a label, never by number, as a guest is.
  const guests: { phone: string; label: string }[] = [];
  for (const phone of invited.invited.keys()) guests.push({ phone, label: await guestLabel(args.groupKey, phone) });
  const timeZone = effectiveTimeZone(undefined, await accountTimeZone(ctx, actor));
  const handle = taggerUser !== null ? await handleOf(ctx, taggerUser) : "";
  const tagger = taggerUser !== null ? {} : { guestTagger: await guestLabel(args.groupKey, args.sender) };
  const mail = await mailSharesNamed(ctx, (await ctx.db.get(chat._id)) ?? chat);
  return { status: "ready", slug: workspace.slug, intro: introduced, bound, timeZone, handle, minted, names, guests, ...tagger, ...(mail.length > 0 ? { mail } : {}) };
}

/** A person's handle: their personal workspace's slug, or "" when they have none. */
async function handleOf(ctx: MutationCtx, userId: Id<"users">): Promise<string> {
  const personal = await personalWorkspaceOf(ctx, userId);
  return personal === null ? "" : ((await ctx.db.get(personal))?.slug ?? "");
}

async function groupRow(ctx: MutationCtx, groupKey: string, now: number): Promise<Doc<"textGroups">> {
  const existing = await ctx.db
    .query("textGroups")
    .withIndex("by_key", (q) => q.eq("groupKey", groupKey))
    .unique();
  if (existing !== null) {
    await ctx.db.patch(existing._id, { lastSeenAt: now });
    return { ...existing, lastSeenAt: now };
  }
  const id = await ctx.db.insert("textGroups", { groupKey, lastSeenAt: now });
  return (await ctx.db.get(id))!;
}

/** The account a phone was linked to by code, unless that account has texting paused. */
async function linkedUser(ctx: MutationCtx, phone: string): Promise<Id<"users"> | null> {
  if (!isPhoneNumber(phone)) return null;
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  if (link === null) return null;
  if (await phoneSignInPaused(ctx, link.userId)) return null;
  return link.userId;
}

/** The shared workspaces every one of `users` is a live member of, oldest slug first. */
export async function sharedWorkspaces(
  ctx: MutationCtx,
  users: Id<"users">[],
): Promise<Doc<"workspaces">[]> {
  if (users.length === 0) return [];
  let common: Id<"workspaces">[] | undefined;
  for (const userId of users) {
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MEMBERSHIP_SCAN);
    const mine = memberships.map((membership) => membership.workspaceId);
    common = common === undefined ? mine : common.filter((id) => mine.includes(id));
    if (common.length === 0) return [];
  }
  const found: Doc<"workspaces">[] = [];
  for (const id of common ?? []) {
    const workspace = await ctx.db.get(id);
    // A personal workspace never counts: it carries its owner's mail, calendar and vault.
    if (workspace !== null && workspace.kind === "shared") found.push(workspace);
  }
  return found.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

async function mintGroupGrant(
  ctx: MutationCtx,
  input: {
    group: Doc<"textGroups">;
    workspaceId: Id<"workspaces">;
    tagger: Id<"users">;
    coViewerIds: Id<"users">[];
    hashedAccessToken: string;
    hashedRefreshToken: string;
    expiresAt: number;
    participants: number;
    /** Guest mode: the chat's group, the person usage counts against, and whether the tagger is a guest. */
    guest?: { groupId: Id<"workspaceGroups">; binder: Id<"users">; guestTagger: boolean };
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
  // A guest chat counts against whoever opened it to guests (the owner, 2026-10-25), whoever tagged Tex.
  const meterWorkspaceId = await personalWorkspaceOf(ctx, input.guest?.binder ?? input.tagger);
  if (meterWorkspaceId === null) return false;
  await ensureGroupClient(ctx);

  const guest = input.guest === undefined ? {} : { guestGroupId: input.guest.groupId, guestTagger: input.guest.guestTagger };
  const invited =
    input.invited === undefined
      ? {}
      : { coInvitationIds: input.invited.invitationIds, ...(taggerRole !== undefined ? { invitedTaggerRole: taggerRole } : {}) };
  const texGroup = { groupId: input.group._id, coViewerIds: input.coViewerIds, meterWorkspaceId, ...guest, ...invited };
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
  await recordAudit(ctx, {
    workspaceId: input.workspaceId,
    actorUserId: input.tagger,
    actorClientId: TEXTS_GROUP_CLIENT_ID,
    action: "texts.group.session.opened",
    details: {
      scopes: scopes.join(" "),
      participants: input.participants,
      ...(input.guest !== undefined ? { guests: true, guestTagger: input.guest.guestTagger } : {}),
      ...(input.invited !== undefined ? { invited: input.invited.invitationIds.length, invitedTagger: taggerRole !== undefined } : {}),
    },
  });
  return true;
}

async function ensureGroupClient(ctx: MutationCtx): Promise<void> {
  const existing = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", TEXTS_GROUP_CLIENT_ID))
    .unique();
  if (existing !== null) return;
  await ctx.db.insert("oauthClients", {
    clientId: TEXTS_GROUP_CLIENT_ID,
    clientName: TEXTS_GROUP_CLIENT_NAME,
    redirectUris: [],
    hashedClientSecret: null,
    tokenEndpointAuthMethod: "none",
    grantTypes: [],
    responseTypes: [],
    createdAt: Date.now(),
  });
}
