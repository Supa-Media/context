/**
 * The Tex page in the Context app (`lib/gatewayRoutes/texPage.ts`): what the signed-in person may see of their
 * Tex, and the two things they may change from it. Called by the gateway with the console's own grant, so the
 * person comes off that live grant and nothing the request names. A grant from any other client, a dead grant,
 * or one with no user answers `refused`, one answer for every reason.
 *
 * Who sees what:
 *  - the chats are the ones whose home names the person (`textGroups.homeUsers`), and nobody else's;
 *  - a chat's routines are the rows tagged with that chat (`routines.chat`), and a person's own routines are the
 *    rows in their personal workspace under the two Tex routine roots.
 *
 * Settings change only what a chat's people may change in the chat (`lib/texChatRules.ts`), the same rules the
 * texted commands and the agent's tools use. A chat the person is not in answers `not_found`, exactly as a
 * missing key does.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type QueryCtx, internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { mergeTexStyle, readTexStyle, texStyleValidator, type TexStyle } from "./lib/texStyle";
import { setChatEngagement, setChatStyle, setPersonStyle, type Engagement } from "./lib/texChatRules";
import { CONSOLE_CLIENT_ID } from "./agentGrant";
import { personalWorkspaceOf } from "./textLinks";

/** The most chats one page lists, and the most routines it carries for a person and for each chat. */
export const MAX_PAGE_CHATS = 20;
export const MAX_CHAT_ROUTINES = 50;
export const MAX_PERSON_ROUTINES = 100;
/** Scanned, not indexed: a person's few group chats are found in a bounded read. */
const CHAT_SCAN = 2000;

/** The two roots a person's own routines live under: the Tex root, and the older one that still runs. */
const ROUTINE_ROOTS = ["tex/routines/", "routines/"] as const;

const CHAT_KEY = /^[0-9a-f]{64}$/;

const engagementValidator = v.union(v.literal("quiet"), v.literal("attentive"), v.literal("followAlong"), v.literal("helpful"), v.null());

const routineValidator = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.string(),
  path: v.string(),
  paused: v.boolean(),
  nextRunAt: v.union(v.number(), v.null()),
  lastRunAt: v.optional(v.number()),
  lastOutcome: v.optional(v.string()),
  unit: v.string(),
  every: v.number(),
  at: v.optional(v.object({ hour: v.number(), minute: v.number() })),
  days: v.optional(v.array(v.number())),
  monthDay: v.optional(v.number()),
  date: v.optional(v.object({ year: v.number(), month: v.number(), day: v.number() })),
  timeZone: v.optional(v.string()),
});

const chatValidator = v.object({
  key: v.string(),
  name: v.string(),
  people: v.number(),
  peopleNames: v.array(v.string()),
  homeWords: v.union(v.string(), v.null()),
  homeWorkspaceId: v.union(v.id("workspaces"), v.null()),
  homeSlug: v.union(v.string(), v.null()),
  muted: v.boolean(),
  engagement: engagementValidator,
  style: texStyleValidator,
  sponsor: v.union(v.string(), v.null()),
  routines: v.array(routineValidator),
});

export const pageValidator = v.union(
  v.object({
    status: v.literal("ok"),
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    handle: v.string(),
    phone: v.union(v.string(), v.null()),
    timeZone: v.union(v.string(), v.null()),
    style: texStyleValidator,
    routines: v.array(routineValidator),
    chats: v.array(chatValidator),
  }),
  v.object({ status: v.literal("refused") }),
);

export const settingsAnswerValidator = v.object({
  status: v.union(v.literal("done"), v.literal("refused"), v.literal("not_found"), v.literal("bad_request"), v.literal("rate_limited")),
  style: v.optional(texStyleValidator),
  engagement: v.optional(v.string()),
});

/** The person a console grant speaks for, or null for any grant that is not the console's, or not live. */
async function consolePerson(ctx: QueryCtx, hashedAccessToken: string): Promise<Id<"users"> | null> {
  const live = await resolveLiveGrant(ctx, hashedAccessToken);
  if (live === null || live.grant.clientId !== CONSOLE_CLIENT_ID) return null;
  const userId: Id<"users"> | undefined = live.grant.userId;
  return userId ?? null;
}

/** A person's handle: their personal workspace's slug, or "" when they have none. */
async function handleFor(ctx: QueryCtx, userId: Id<"users">): Promise<string> {
  const personal = await personalWorkspaceOf(ctx, userId);
  return personal === null ? "" : ((await ctx.db.get(personal))?.slug ?? "");
}

/**
 * A group chat as the page names it: by the people in it (`@bo, @cy +2`). A
 * chat keeps no name of its own: the iMessage group's display name is never
 * read, since anyone in the chat can set it, and the chat home's folder words
 * are random, so they would name nothing the person knows.
 */
export function groupName(peopleNames: readonly string[]): string {
  const others = peopleNames.filter((name) => name !== "You").map((name) => (name === "Someone" ? name : `@${name}`));
  if (others.length === 0) return "Group chat";
  const rest = others.length - 2;
  return `${others.slice(0, 2).join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
}

type Routine = typeof routineValidator.type;

/** A routine row as the page shows it: its schedule and its last outcome code, never its note. */
function routineOf(row: Doc<"routines">, slug: string): Routine {
  return {
    workspaceId: row.workspaceId,
    slug,
    path: row.path,
    paused: row.paused,
    nextRunAt: row.nextRunAt,
    ...(row.lastRunAt !== undefined ? { lastRunAt: row.lastRunAt } : {}),
    ...(row.lastOutcome !== undefined ? { lastOutcome: row.lastOutcome } : {}),
    unit: row.cadence.unit,
    every: row.cadence.every,
    ...(row.at !== undefined ? { at: row.at } : {}),
    ...(row.days !== undefined ? { days: row.days } : {}),
    ...(row.monthDay !== undefined ? { monthDay: row.monthDay } : {}),
    ...(row.date !== undefined ? { date: row.date } : {}),
    ...(row.timeZone !== undefined ? { timeZone: row.timeZone } : {}),
  };
}

/** Slugs read once per workspace, so a page with many routines in one workspace reads it once. */
function slugCache(ctx: QueryCtx) {
  const slugs = new Map<Id<"workspaces">, Promise<string>>();
  return (workspaceId: Id<"workspaces">): Promise<string> => {
    let slug = slugs.get(workspaceId);
    if (slug === undefined) {
      slug = ctx.db.get(workspaceId).then((workspace) => workspace?.slug ?? "");
      slugs.set(workspaceId, slug);
    }
    return slug;
  };
}

/** The person's routines under the Tex roots of their personal workspace, capped. */
async function personRoutines(ctx: QueryCtx, workspaceId: Id<"workspaces">, slugOf: (id: Id<"workspaces">) => Promise<string>): Promise<Routine[]> {
  const out: Routine[] = [];
  for (const root of ROUTINE_ROOTS) {
    const rows = await ctx.db
      .query("routines")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).gte("path", root).lt("path", root.slice(0, -1) + "0"))
      .take(MAX_PERSON_ROUTINES);
    for (const row of rows) out.push(routineOf(row, await slugOf(row.workspaceId)));
  }
  return out.slice(0, MAX_PERSON_ROUTINES);
}

/** The routines tagged with one group chat (`routines.chat`: the first 16 hex of its key), capped. */
async function chatRoutines(ctx: QueryCtx, key: string, slugOf: (id: Id<"workspaces">) => Promise<string>): Promise<Routine[]> {
  const rows = await ctx.db
    .query("routines")
    .withIndex("by_chat", (q) => q.eq("chat", key.slice(0, 16)))
    .take(MAX_CHAT_ROUTINES);
  return await Promise.all(rows.map(async (row) => routineOf(row, await slugOf(row.workspaceId))));
}

/**
 * The Tex page for the person a console grant speaks for. `refused` for any grant that is not the console's, not
 * live, or whose person has no personal workspace of their own.
 */
export const pageFor = internalQuery({
  args: { hashedAccessToken: v.string() },
  returns: pageValidator,
  handler: async (ctx, args) => {
    const userId = await consolePerson(ctx, args.hashedAccessToken);
    if (userId === null) return { status: "refused" as const };
    const workspaceId = await personalWorkspaceOf(ctx, userId);
    const workspace = workspaceId === null ? null : await ctx.db.get(workspaceId);
    if (workspace === null || workspaceId === null) return { status: "refused" as const };

    const phone = (await ctx.db.query("phoneLinks").withIndex("by_user", (q) => q.eq("userId", userId)).first())?.phone ?? null;
    const timeZone = (await ctx.db.query("accountTimeZones").withIndex("by_user", (q) => q.eq("userId", userId)).unique())?.timeZone ?? null;
    const style = (await ctx.db.query("texStylePreferences").withIndex("by_user", (q) => q.eq("userId", userId)).unique())?.texStyle ?? {};

    const slugOf = slugCache(ctx);
    const routines = await personRoutines(ctx, workspaceId, slugOf);

    const pinned = await pinnedContextWorkspace(ctx);
    const handles = new Map<Id<"users">, Promise<string>>();
    const handleOnce = (id: Id<"users">) => {
      let handle = handles.get(id);
      if (handle === undefined) {
        handle = handleFor(ctx, id);
        handles.set(id, handle);
      }
      return handle;
    };

    // No index on homeUsers: Tex has few group chats, so one bounded scan finds the person's.
    const mine = (await ctx.db.query("textGroups").take(CHAT_SCAN))
      .filter((chat) => (chat.homeUsers ?? []).includes(userId))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, MAX_PAGE_CHATS);

    const chats = await Promise.all(
      mine.map(async (chat) => {
        const homeUsers = chat.homeUsers ?? [];
        const peopleNames = await Promise.all(
          homeUsers.map(async (id) => (id === userId ? "You" : (await handleOnce(id)) || "Someone")),
        );
        const sponsorId = chat.sponsorId ?? chat.boundBy ?? null;
        const sponsor = sponsorId === null ? null : (await handleOnce(sponsorId)) || null;
        const homed = chat.homeWords !== undefined && pinned !== null;
        return {
          key: chat.groupKey,
          name: groupName(peopleNames),
          people: Math.max(1, homeUsers.length),
          peopleNames: homeUsers.length > 0 ? peopleNames : ["You"],
          homeWords: chat.homeWords ?? null,
          homeWorkspaceId: homed ? pinned._id : null,
          homeSlug: homed ? pinned.slug : null,
          muted: chat.mutedAt !== undefined,
          engagement: chat.engagement ?? null,
          style: mergeTexStyle(chat.texStyle, {}),
          sponsor,
          routines: await chatRoutines(ctx, chat.groupKey, slugOf),
        };
      }),
    );

    return {
      status: "ok" as const,
      userId,
      workspaceId,
      handle: workspace.slug,
      phone,
      timeZone,
      style,
      routines,
      chats,
    };
  },
});

/** A settings call, read from the wire: `me` with a style, or a chat key with a style and `answers`. */
export type TexPageSettings =
  | { kind: "me"; patch: TexStyle }
  | { kind: "chat"; key: string; patch: TexStyle; engagement: Engagement | undefined };

/** The engagement a page's `answers` word stands for. */
const ANSWERS: Record<string, Engagement> = { named: "attentive", every: "helpful" };

/** Read a settings call, or null for anything that is not one. Pure, so the route and the write agree. */
export function readTexPageSettings(chat: unknown, values: unknown): TexPageSettings | null {
  if (typeof chat !== "string" || values === null || typeof values !== "object" || Array.isArray(values)) return null;
  if (chat === "me") {
    const patch = readTexStyle(values);
    return patch === null ? null : { kind: "me", patch };
  }
  if (!CHAT_KEY.test(chat)) return null;
  const { answers, ...style } = values as Record<string, unknown>;
  const patch = readTexStyle(style);
  if (patch === null) return null;
  let engagement: Engagement | undefined;
  if (answers !== undefined) {
    if (typeof answers !== "string" || !Object.prototype.hasOwnProperty.call(ANSWERS, answers)) return null;
    engagement = ANSWERS[answers];
  }
  return { kind: "chat", key: chat, patch, engagement };
}

/**
 * One settings change, as the person the console grant names. `me` lays the patch over their own style; a chat
 * key lays its style and "when Tex speaks up" over that chat, and only if the person is one of its people.
 * Refused whole on a bad value, and a rate limit answers `rate_limited` with nothing written.
 */
export const applyTexPageSettings = internalMutation({
  args: { hashedAccessToken: v.string(), chat: v.string(), values: v.any() },
  returns: settingsAnswerValidator,
  handler: async (ctx, args) => {
    const settings = readTexPageSettings(args.chat, args.values);
    if (settings === null) return { status: "bad_request" as const };
    const userId = await consolePerson(ctx, args.hashedAccessToken);
    if (userId === null) return { status: "refused" as const };
    try {
      if (settings.kind === "me") {
        const style = await setPersonStyle(ctx, userId, settings.patch);
        return { status: "done" as const, style };
      }
      const group = await ctx.db
        .query("textGroups")
        .withIndex("by_key", (q) => q.eq("groupKey", settings.key))
        .unique();
      if (group === null || !(group.homeUsers ?? []).includes(userId)) return { status: "not_found" as const };
      const setBy = (await handleFor(ctx, userId)) || "someone here";
      // Style first: its rate limit throws before anything is written, so a limited call changes neither setting.
      const style =
        Object.keys(settings.patch).length > 0 ? await setChatStyle(ctx, group, settings.patch, setBy) : mergeTexStyle(group.texStyle, {});
      if (settings.engagement !== undefined) await setChatEngagement(ctx, group, settings.engagement, setBy);
      return {
        status: "done" as const,
        style,
        ...(settings.engagement !== undefined ? { engagement: settings.engagement } : {}),
      };
    } catch (error) {
      if ((error as { data?: { code?: unknown } })?.data?.code === "RATE_LIMITED") return { status: "rate_limited" as const };
      throw error;
    }
  },
});
