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
import { MAX_INSTRUCTIONS, QUICK_PICKS, type InstructionsChange } from "./lib/texInstructions";
import { personRow, setChatSettings, setPersonSettings, setSpeaksUp, speaksUpOf } from "./lib/texChatRules";
import type { Engagement } from "./textGroups";
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
  /** The chat's own instructions (`lib/texInstructions.ts`, Dev2, 2026-11-01), or null for none. */
  instructions: v.union(v.string(), v.null()),
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
    /** The person's own instructions, or null; and the quick picks the page offers, by id and label. */
    instructions: v.union(v.string(), v.null()),
    picks: v.array(v.object({ id: v.string(), label: v.string() })),
    routines: v.array(routineValidator),
    chats: v.array(chatValidator),
  }),
  v.object({ status: v.literal("refused") }),
);

export const settingsAnswerValidator = v.object({
  status: v.union(v.literal("done"), v.literal("refused"), v.literal("not_found"), v.literal("bad_request"), v.literal("rate_limited")),
  instructions: v.optional(v.string()),
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
export async function handleFor(ctx: QueryCtx, userId: Id<"users">): Promise<string> {
  const personal = await personalWorkspaceOf(ctx, userId);
  return personal === null ? "" : ((await ctx.db.get(personal))?.slug ?? "");
}

/**
 * A group chat with no name of its own, as the page names it: by the people in
 * it (`@bo, @cy +2`). A chat with an iMessage name is shown by it
 * (`textGroupNames.ts`, the owner, 2026-11-02); the home's folder words are
 * random, so they would name nothing the person knows.
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
    const instructions = (await personRow(ctx, userId))?.instructions ?? null;

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
          name: chat.chatName ?? groupName(peopleNames),
          people: Math.max(1, homeUsers.length),
          peopleNames: homeUsers.length > 0 ? peopleNames : ["You"],
          homeWords: chat.homeWords ?? null,
          homeWorkspaceId: homed ? pinned._id : null,
          homeSlug: homed ? pinned.slug : null,
          muted: speaksUpOf(chat) === "off",
          engagement: ((level) => (level === undefined || level === "off" ? null : level))(speaksUpOf(chat)),
          instructions: chat.instructions ?? null,
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
      instructions,
      picks: QUICK_PICKS.map(({ id, label }) => ({ id, label })),
      routines,
      chats,
    };
  },
});

/** A settings call, read from the wire: `me` or a chat key, with the whole text or a quick pick, and `answers` for a chat. */
export type TexPageSettings =
  | { kind: "me"; change: InstructionsChange | undefined }
  | { kind: "chat"; key: string; change: InstructionsChange | undefined; engagement: Engagement | undefined };

/** The engagement a page's `answers` word stands for. */
const ANSWERS: Record<string, Engagement> = { named: "attentive", every: "helpful" };

/** `{ instructions }` (the whole text) or `{ pick }` (a quick pick's id); undefined for neither, null for anything off. */
function changeOf(values: Record<string, unknown>): InstructionsChange | undefined | null {
  const { instructions, pick } = values;
  if (instructions !== undefined && pick !== undefined) return null;
  if (instructions !== undefined) return typeof instructions === "string" && instructions.length <= MAX_INSTRUCTIONS ? { replace: instructions } : null;
  if (pick !== undefined) return typeof pick === "string" && QUICK_PICKS.some((entry) => entry.id === pick) ? { pick } : null;
  return undefined;
}

/** Read a settings call, or null for anything that is not one. Pure, so the route and the write agree. */
export function readTexPageSettings(chat: unknown, values: unknown): TexPageSettings | null {
  if (typeof chat !== "string" || values === null || typeof values !== "object" || Array.isArray(values)) return null;
  const { answers, ...rest } = values as Record<string, unknown>;
  if (Object.keys(rest).some((key) => key !== "instructions" && key !== "pick")) return null;
  const change = changeOf(rest);
  if (change === null) return null;
  if (chat === "me") return answers === undefined && change !== undefined ? { kind: "me", change } : null;
  if (!CHAT_KEY.test(chat)) return null;
  let engagement: Engagement | undefined;
  if (answers !== undefined) {
    if (typeof answers !== "string" || !Object.prototype.hasOwnProperty.call(ANSWERS, answers)) return null;
    engagement = ANSWERS[answers];
  }
  return { kind: "chat", key: chat, change, engagement };
}

/**
 * One settings change, as the person the console grant names. `me` changes their own instructions; a chat key
 * changes that chat's instructions and "when Tex speaks up", and only if the person is one of its people.
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
        const saved = await setPersonSettings(ctx, userId, { change: settings.change });
        return "refused" in saved ? { status: "bad_request" as const } : { status: "done" as const, ...(saved.instructions ? { instructions: saved.instructions } : {}) };
      }
      const group = await ctx.db
        .query("textGroups")
        .withIndex("by_key", (q) => q.eq("groupKey", settings.key))
        .unique();
      if (group === null || !(group.homeUsers ?? []).includes(userId)) return { status: "not_found" as const };
      const setBy = (await handleFor(ctx, userId)) || "someone here";
      // The text first: its rate limit throws before anything is written, so a limited call changes neither setting.
      let instructions = group.instructions;
      if (settings.change !== undefined) {
        const saved = await setChatSettings(ctx, group, { change: settings.change }, setBy);
        if ("refused" in saved) return { status: "bad_request" as const };
        instructions = saved.instructions;
      }
      if (settings.engagement !== undefined) await setSpeaksUp(ctx, group, settings.engagement, setBy);
      return {
        status: "done" as const,
        ...(instructions ? { instructions } : {}),
        ...(settings.engagement !== undefined ? { engagement: settings.engagement } : {}),
      };
    } catch (error) {
      if ((error as { data?: { code?: unknown } })?.data?.code === "RATE_LIMITED") return { status: "rate_limited" as const };
      throw error;
    }
  },
});
