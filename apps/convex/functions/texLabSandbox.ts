/**
 * The Lab's test chats, the control plane's half (Dev2, 2026-11-16: "send test messages to see how the new architecture
 * responds ... have all the changes sandboxed so it doesn't actually affect production"; decision
 * `docs/decisions/texting-assistant/lab-sandbox.md`). The gateway's `/tex-lab/sandbox` asks here, and only reads:
 *
 *  - `who`: is the caller a Tex developer, and which chats may they open (their own 1:1, and each group chat they are
 *    in, as the Tex page lists them). The Lab's own client (`context_console`) is let in as well as an AI client's,
 *    since the Lab is where test chats are used; everything else is `texDeveloper`'s rule (staff, pinned owner/editor).
 *  - `session`: the session a real texted turn in that chat would run on, read from the chat's own live grant without
 *    its token, so the gateway's test turn is the same turn. Never a token: the gateway keeps the caller's.
 *  - `draft`: a Lab draft's graph, the config the test turn runs.
 *  - `set`: a Training or Dev conversation's Lab draft, a test chat's history when the Lab tries a text on one.
 *  - `sets`: every Training and Dev draft (`texSets.ts` `listDrafts`), which the gateway lays over the repo's copy for
 *    the Lab picker's Training / Dev tab. Never the Test Set: it is not kept here.
 *  - `shared`: the chats people shared with the developers (`lib/texLabShared.ts`), each with where its history file
 *    lives, for the picker's "Shared with devs" tab and its history reads; `session { chat, shared: true }` the session
 *    a test turn in one runs on, read from the sharer's own live grant, only while the chat is listed (Dev2 chose
 *    "Allow test texts" on 2026-11-16; the yes's wording says so for every new yes).
 */

import { v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { userIsStaff } from "./lib/admin";
import { contextsForGrant, resolveLiveGrant, texChatIdOf, type LiveGrant } from "./lib/controlPlane/liveGrants";
import { flagsFor } from "./lib/featureFlags";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { getMembership } from "./lib/workspaceAuth";
import { pageForUser, handleFor } from "./texPage";
import { listDrafts } from "./texSets";
import { sharedChats, devShareOf } from "./lib/texLabShared";
import { engagementOf, TEXTS_GROUP_CLIENT_ID } from "./textGroups";
import { oldLineSetting } from "./texOldLine";
import { mailSharesWithSenders } from "./lib/textGroupMail";
import { calendarSharesNamed } from "./lib/textGroupCalendar";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { groupsOfUser } from "./lib/texIdentity/groups";
import { isIsolatedPreview } from "./lib/previewDeployment";
import { WORLD_GROUP_ID, worldChatKey, worldPeopleOf, worldReach, worldWorkspaces } from "./lib/texLabWorldReach";

const CONSOLE_CLIENT_ID = "context_console";
const CHAT_KEY = /^[0-9a-f]{64}$/;

/** The person a grant speaks for, when they may use the Lab's test chats; null for anyone else. */
export async function sandboxCaller(ctx: QueryCtx, hashedAccessToken: string): Promise<Id<"users"> | null> {
  const live = await resolveLiveGrant(ctx, hashedAccessToken);
  if (live === null) return null;
  const client = live.grant.clientId;
  if (client !== CONSOLE_CLIENT_ID && client.startsWith("context_")) return null;
  const userId = live.grant.userId;
  if (!userId) return null;
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null) return null;
  const membership = await getMembership(ctx, pinned._id, userId);
  if (membership === null || (membership.role !== "owner" && membership.role !== "editor")) return null;
  if (!(await userIsStaff(ctx, userId))) return null;
  return userId;
}

/** A grant as a live session would read it, without its token's own expiry: a test turn uses no token of the chat's. */
async function liveWithoutToken(ctx: QueryCtx, grant: Doc<"oauthGrants">): Promise<LiveGrant | null> {
  if (grant.status !== "active") return null;
  const workspace = await ctx.db.get(grant.workspaceId);
  if (workspace === null) return null;
  const membership = await getMembership(ctx, grant.workspaceId, grant.userId);
  if (membership !== null) return { grant, workspace, role: membership.role };
  // A home-only group grant is the pin's, and its sponsor is not a member of it.
  if (grant.clientId === TEXTS_GROUP_CLIENT_ID && grant.texGroup?.homeOnly === true) {
    const pinned = await pinnedContextWorkspace(ctx);
    if (pinned !== null && pinned._id === grant.workspaceId) return { grant, workspace: pinned, role: "editor" };
  }
  return null;
}

/** The session `/gateway/session` would answer for this grant (`lib/gatewayRoutes/sessions.ts`), without a token. */
async function sessionOf(ctx: QueryCtx, live: LiveGrant) {
  const chatId = await texChatIdOf(ctx, live);
  return {
    grantId: live.grant._id,
    clientId: live.grant.clientId,
    clientName: null,
    actorUserId: live.grant.userId,
    scopes: live.grant.scopes,
    expiresAt: Date.now() + 15 * 60_000,
    toolsListedAt: live.grant.toolsListedAt ?? live.grant.createdAt,
    defaultWorkspaceId: live.grant.workspaceId,
    workspaces: await contextsForGrant(ctx, live),
    ...(chatId === null ? {} : { texChatId: chatId }),
    flags: await flagsFor(ctx, live.grant.userId),
  };
}

async function sessionFor(ctx: QueryCtx, userId: Id<"users">, chat: string) {
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  if (chat === "me") {
    const own = grants.filter((grant) => grant.clientId === TEXTS_CLIENT_ID && grant.status === "active").sort((a, b) => b.createdAt - a.createdAt);
    for (const grant of own) {
      const live = await liveWithoutToken(ctx, grant);
      // Their group chats too, so a draft that lets the 1:1 read them is tested on the real list (`lib/texIdentity/groups.ts`).
      if (live !== null) return { status: "ok" as const, session: await sessionOf(ctx, live), people: [{ handle: await handleFor(ctx, userId), name: "You" }], chat: { oldLine: await oldLineSetting(ctx), groups: await groupsOfUser(ctx, userId) } };
    }
    return { status: "not_found" as const, error: "Tex has no texting grant for you yet: text Tex once first." };
  }
  if (!CHAT_KEY.test(chat)) return { status: "bad_request" as const, error: "chat is \"me\" or a group chat's key" };
  const group = await ctx.db
    .query("textGroups")
    .withIndex("by_key", (q) => q.eq("groupKey", chat))
    .unique();
  // A chat the person is not in answers as one that does not exist.
  if (group === null || !(group.homeUsers ?? []).includes(userId)) return { status: "not_found" as const, error: "There is no such chat." };
  // A chat's run nobody asked for stands on its sponsor's grant (`textGroups.sponsorId`): read the sponsor's grants too.
  const sponsor = group.sponsorId ?? group.boundBy ?? null;
  const sponsorGrants = sponsor === null || sponsor === userId ? [] : await ctx.db
    .query("oauthGrants")
    .withIndex("by_user", (q) => q.eq("userId", sponsor))
    .collect();
  // Their own asker's grant first (`textGroupHomeOnly.ts`: a text reads the asker's reach), then the sponsor's.
  const own = (grant: Doc<"oauthGrants">) => (grant.userId === userId && grant.texGroup?.reachFor === "asker" ? 1 : 0);
  const mine = [...grants, ...sponsorGrants].filter((grant) => grant.clientId === TEXTS_GROUP_CLIENT_ID && grant.status === "active" && grant.texGroup?.groupId === group._id).sort((a, b) => own(b) - own(a) || b.createdAt - a.createdAt);
  for (const grant of mine) {
    const live = await liveWithoutToken(ctx, grant);
    if (live === null) continue;
    const people = await Promise.all((group.homeUsers ?? []).map(async (id) => ({ handle: await handleFor(ctx, id), name: id === userId ? "You" : (await handleFor(ctx, id)) || "Someone" })));
    // What the control plane tells the chat's object about it on each turn (`textGroups.ts` "ready"), read without minting.
    // Its shared mail and calendars too, as a real turn is told them (`textGroups.ts` "ready"); a test chat's reads of
    // that mail stay real reads on this grant, and a send is only kept in the test chat (`labSandbox/sandboxTools.js`).
    const mail = await Promise.all((await mailSharesWithSenders(ctx, group, group.homeUsers ?? [])).map(async (row) => ({ ...row, senders: await Promise.all(row.senders.map((id) => handleFor(ctx, id))) })));
    const { calendar } = await calendarSharesNamed(ctx, group._id);
    const chat = { slug: live.workspace.slug, ...engagementOf(group), oldLine: await oldLineSetting(ctx), ...(await devShareOf(ctx, group)), ...(mail.length > 0 ? { mail } : {}), ...(calendar ? { calendar } : {}) };
    return { status: "ok" as const, session: await sessionOf(ctx, live), people, chat };
  }
  return { status: "not_found" as const, error: "Tex has not answered you in this chat yet: tag it there once first." };
}

/**
 * The session a test turn in a chat shared with the developers runs on: the sharer's own, as if they had texted it.
 * Only while the chat is listed (`sharedChats`, asked again on every test text); a 1:1 as its person, a group as one of
 * its people with a live grant there (the sponsor first). Names are handles, never "You": the caller is not in it.
 */
export async function sharedSessionFor(ctx: QueryCtx, callerId: Id<"users">, chat: string) {
  const shared = await sharedChats(ctx, callerId);
  const listed = shared.find((c) => c.key === chat);
  if (!listed) return { status: "not_found" as const, error: "That chat isn't shared with the developers (or no longer is)." };
  if (listed.kind === "1:1") {
    const sharer = chat.slice(2) as Id<"users">;
    const answer = await sessionFor(ctx, sharer, "me");
    // Sharing a 1:1 shares that chat, never the sharer's other group chats: a test turn there reads only the groups
    // that are shared with the developers too (Dev2, 2026-11-17: test reading groups from Sayo's 1:1).
    if (answer.status !== "ok") return answer;
    const sharedGroups = new Set(shared.filter((c) => c.kind === "group").map((c) => c.key));
    const groups = (await groupsOfUser(ctx, sharer)).filter((g) => sharedGroups.has(g.key));
    return { ...answer, people: [{ handle: await handleFor(ctx, sharer), name: listed.name }], chat: { ...answer.chat, groups } };
  }
  const group = await ctx.db
    .query("textGroups")
    .withIndex("by_key", (q) => q.eq("groupKey", chat))
    .unique();
  if (group === null) return { status: "not_found" as const, error: "There is no such chat." };
  const home = group.homeUsers ?? [];
  const sponsor = group.sponsorId ?? group.boundBy ?? null;
  const order = sponsor !== null && home.includes(sponsor) ? [sponsor, ...home.filter((id) => id !== sponsor)] : home;
  for (const member of order) {
    const answer = await sessionFor(ctx, member, chat);
    if (answer.status !== "ok") continue;
    const people = await Promise.all(home.map(async (id) => {
      const handle = await handleFor(ctx, id);
      return { handle, name: handle || "Someone" };
    }));
    return { ...answer, people };
  }
  return { status: "not_found" as const, error: "Tex has not answered in this chat yet." };
}

/** The most phones, and the most groups, one sweep reads: far above Tex's chats today, and bounded. */
const INTAKE_SCAN = 5_000;

/** Each linked phone, once, and each group chat's key: every chat Tex can name (the gateway's intake sweep). */
export async function intakeChats(ctx: QueryCtx): Promise<{ phones: string[]; groups: string[] }> {
  const phones = [...new Set((await ctx.db.query("phoneLinks").take(INTAKE_SCAN)).map((row) => row.phone))];
  const groups = (await ctx.db.query("textGroups").take(INTAKE_SCAN)).map((group) => group.groupKey);
  return { phones, groups };
}

/** Whether a grant's person may use the Lab's test chats (`sandboxCaller`), for the one write the route makes. */
export const mayUseTestChats = internalQuery({
  args: { hashedAccessToken: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { hashedAccessToken }) => (await sandboxCaller(ctx, hashedAccessToken)) !== null,
});

/** One `/gateway/tex/lab-sandbox` call. Reads only, always an answer with a `status`. */
export const forGateway = internalQuery({
  args: { hashedAccessToken: v.string(), action: v.string(), args: v.any() },
  returns: v.any(),
  handler: async (ctx, { hashedAccessToken, action, args }) => {
    const userId = await sandboxCaller(ctx, hashedAccessToken);
    if (userId === null) return { status: "refused" };
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    if (action === "who") return { ...(await pageForUser(ctx, userId)), userId };
    if (action === "shared") return { status: "ok", chats: await sharedChats(ctx, userId) };
    // Every chat Tex can name, for the gateway's sweep that moves the last ones into the gateway (`intake.js`): each
    // linked phone's 1:1 and each group's key. Read only, for staff only (`sandboxCaller`); the gateway never answers them.
    if (action === "intakeChats") return { status: "ok", ...(await intakeChats(ctx)) };
    if (action === "session" && a.shared === true) return await sharedSessionFor(ctx, userId, typeof a.chat === "string" ? a.chat : "");
    if (action === "session") return await sessionFor(ctx, userId, typeof a.chat === "string" ? a.chat : "me");
    // A made-up group chat on main (`lib/texLabWorldReach.ts`): the Lab user's own session, narrowed to what a chat of
    // these people would reach; and the workspaces its people can be given roles in (on a preview, the made-up ones are).
    if (action === "worldWorkspaces") return { status: "ok", preview: isIsolatedPreview(), workspaces: (await worldWorkspaces(ctx, userId)).map(({ slug, name }) => ({ slug, name })) };
    if (action === "worldReach") {
      const people = worldPeopleOf(a.people);
      if (people === null) return { status: "bad_request", error: "people are [{ name, account, roles?, invited? }], at most 8" };
      if (typeof a.chat !== "string" || !WORLD_GROUP_ID.test(a.chat)) return { status: "bad_request", error: "chat is the made-up chat's group id (lab-world-<16 hex>)" };
      const chatKey = await worldChatKey(ctx, a.chat);
      if (chatKey === null) return { status: "refused", error: "That made-up chat can't be used." };
      const base = await sessionFor(ctx, userId, "me");
      if (base.status !== "ok") return base;
      // The text's sender, by name: their text reads their reach (`textGroupReach.ts` `askerReach`).
      const asker = typeof a.asker === "string" && a.asker.length <= 40 ? a.asker : undefined;
      return await worldReach(ctx, userId, base.session, people, chatKey, asker);
    }
    if (action === "draft") {
      if (a.draft === "main" || a.draft === undefined || a.draft === null) return { status: "ok", graph: null };
      if (typeof a.draft !== "string") return { status: "bad_request" };
      const row = await ctx.db
        .query("texLabVersions")
        .withIndex("by_version", (q) => q.eq("versionId", a.draft as string))
        .unique();
      return row === null ? { status: "not_found" } : { status: "ok", graph: row.graph, name: row.name };
    }
    if (action === "set") {
      // A Training or Dev conversation's Lab draft, when it has one; the gateway reads the repo's copy otherwise. Never
      // the Test Set: it is not kept here (`texSets.ts`).
      if (typeof a.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(a.id)) return { status: "bad_request" };
      const row = await ctx.db
        .query("texSetConvos")
        .withIndex("by_convo", (q) => q.eq("convoId", a.id as string))
        .unique();
      if (row === null || row.removed === true) return { status: "not_found" };
      return { status: "ok", conv: row.data };
    }
    if (action === "sets") {
      // Every Training and Dev draft, for the Lab test chats' picker (the gateway lays them over the repo's copy). The
      // Test Set is never in this table; a row that says otherwise is left out all the same.
      const drafts = (await listDrafts(ctx)).filter((d) => d.set === "training" || d.set === "dev");
      return { status: "ok", drafts: drafts.map(({ id, set, conv, removed }) => ({ id, set, conv, removed })) };
    }
    return { status: "bad_request" };
  },
});
