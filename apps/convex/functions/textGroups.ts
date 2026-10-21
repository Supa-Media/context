import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { phoneSignInPaused } from "./lib/emailProof";
import { recordAudit } from "./lib/audit";
import { SCOPE_READ, SCOPE_WRITE, clampScopes, hasOperationScope } from "./lib/consentScopes";
import { hashToken } from "./lib/crypto";
import { accountTimeZone } from "./lib/routines/access";
import { effectiveTimeZone } from "./lib/routines/model";
import { isPhoneNumber, personalWorkspaceOf } from "./textLinks";

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
/** Most workspaces read per person when intersecting; nobody is in this many. */
const MEMBERSHIP_SCAN = 200;
/** The longest workspace slug a command may name. */
const MAX_SLUG = 64;

const commandValidator = v.union(
  v.object({ kind: v.literal("stop") }),
  v.object({ kind: v.literal("start") }),
  v.object({ kind: v.literal("use"), slug: v.string() }),
);

export const groupAnswerValidator = v.union(
  v.object({ status: v.literal("refused") }),
  v.object({ status: v.literal("muted") }),
  v.object({ status: v.literal("stopped") }),
  v.object({ status: v.literal("started") }),
  v.object({ status: v.literal("unknown_sender"), tell: v.boolean() }),
  v.object({ status: v.literal("no_shared") }),
  v.object({ status: v.literal("not_shared") }),
  v.object({ status: v.literal("choose"), slugs: v.array(v.string()) }),
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
  }),
);

export type GroupAnswer =
  | { status: "refused" | "muted" | "stopped" | "started" | "no_shared" | "not_shared" }
  | { status: "unknown_sender"; tell: boolean }
  | { status: "choose"; slugs: string[] }
  | { status: "ready"; slug: string; intro: boolean; bound: boolean; timeZone: string; handle: string; minted: boolean };

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

    if (senderUser === null) {
      // Told once per person per chat, and by a salted hash, never the number.
      const told = new Set(group.toldUnknown ?? []);
      const mark = await hashToken(`${args.groupKey}:${args.sender}`);
      const tell = !told.has(mark);
      if (tell) await ctx.db.patch(group._id, { toldUnknown: [...told, mark].slice(-MAX_GROUP_PARTICIPANTS) });
      return { status: "unknown_sender", tell };
    }

    const users: Id<"users">[] = [];
    for (const phone of others) {
      const userId = phone === args.sender ? senderUser : await linkedUser(ctx, phone);
      if (userId === null) return { status: "no_shared" };
      if (!users.includes(userId)) users.push(userId);
    }

    const shared = await sharedWorkspaces(ctx, users);
    if (shared.length === 0) return { status: "no_shared" };

    let bound = false;
    let workspace = shared.find((entry) => entry._id === group.workspaceId) ?? null;
    if (args.command?.kind === "use") {
      const slug = args.command.slug.trim().replace(/^@/, "").toLowerCase().slice(0, MAX_SLUG);
      const chosen = shared.find((entry) => entry.slug === slug) ?? null;
      if (chosen === null) return { status: "not_shared" };
      bound = chosen._id !== group.workspaceId;
      workspace = chosen;
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
      if (intro) await ctx.db.patch(group._id, { introducedAt: now });
    }
    const personal = await personalWorkspaceOf(ctx, senderUser);
    const handle = personal === null ? "" : (await ctx.db.get(personal))?.slug ?? "";
    return { status: "ready", slug: workspace.slug, intro: intro && minted, bound, timeZone, handle, minted };
  },
});

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
  },
): Promise<boolean> {
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", input.workspaceId).eq("userId", input.tagger))
    .unique();
  if (membership === null) return false;
  // Never `context:private`: a group reads at team tier whoever tagged Tex.
  const scopes = clampScopes([SCOPE_READ, SCOPE_WRITE], membership.role);
  if (!hasOperationScope(scopes)) return false;
  const meterWorkspaceId = await personalWorkspaceOf(ctx, input.tagger);
  if (meterWorkspaceId === null) return false;
  await ensureGroupClient(ctx);

  const texGroup = { groupId: input.group._id, coViewerIds: input.coViewerIds, meterWorkspaceId };
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
    details: { scopes: scopes.join(" "), participants: input.participants },
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
