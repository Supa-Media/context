/**
 * Moving chats to Tex's new number one at a time (Dev2, 2026-11-15: "I can see all the individual people and groups, and
 * I can flick a switch where their existing text sends them a message to change the phone number ... I just want to be
 * able to do it one by one and sort of monitor if it works").
 *
 *     Staff console, Platform → Lines: a switch per person and group
 *       │  askTexChatMove: the row is `asked` (audited)
 *       ▼
 *     The texting Worker's cron, once a minute (`packages/tex/worker/moveChats.ts`, node `moveChat`)
 *       │  claimTexChatMoves: up to five `asked` rows turn `sending`
 *       │  sends the one text on the chat's old line
 *       ▼  reportTexChatMove: `told`, or `failed` with a code
 *     The person's first text on the new line: `moved`
 *
 * The old line keeps answering every chat as before (Dev2, 2026-11-15: "support the old sendblue numbers still"); a move
 * only tells the chat where Tex is now. Staff see phones and names here, as they do on People; the Worker is handed only
 * the phone or group key it sends to, and logs carry outcomes, never a number.
 */

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { requireAdmin, type AdminActor } from "./lib/admin";
import { recordAdminAudit } from "./lib/adminFns/audit";
import { toConvexError } from "./lib/adminFns/errors";
import { isPhoneNumber } from "./textLinks";
import { groupName, handleFor } from "./texPage";

/** At most this many moves are handed to the Worker each minute, so a slip is caught while it is still one or two chats. */
export const MOVES_PER_CLAIM = 5;
/** A move the Worker took and never reported on is handed out again after this long. */
export const MOVE_CLAIM_MS = 10 * 60 * 1000;
/** Rows the console lists, of each kind. */
const MAX_LISTED = 500;
const GROUP_KEY = /^[0-9a-f]{64}$/;
/** The codes a report may carry (`packages/tex/worker/moveChats.ts`); anything else is kept as `unknown`. */
const DETAILS = new Set(["already_told", "on_new_line", "no_chat", "not_old_line", "no_number", "no_gateway", "node_failed", "send_failed", "unreachable", "members_unread", "add_failed", "remove_failed", "unknown"]);

const kindValidator = v.union(v.literal("person"), v.literal("group"));
const statusValidator = v.union(v.literal("asked"), v.literal("sending"), v.literal("told"), v.literal("moved"), v.literal("failed"));
const moveValidator = v.object({
  status: statusValidator,
  detail: v.union(v.string(), v.null()),
  askedAt: v.number(),
  toldAt: v.union(v.number(), v.null()),
  movedAt: v.union(v.number(), v.null()),
  updatedAt: v.number(),
});
const listValidator = v.object({
  people: v.array(v.object({ phone: v.string(), name: v.string(), move: v.union(moveValidator, v.null()) })),
  groups: v.array(v.object({ groupKey: v.string(), name: v.string(), people: v.number(), lastSeenAt: v.number(), move: v.union(moveValidator, v.null()) })),
});

type Kind = "person" | "group";
type MoveRow = Doc<"texChatMoves">;

function refuse(message: string): never {
  throw new ConvexError({ code: "INVALID_ARGUMENT", message });
}

async function staff(ctx: QueryCtx): Promise<AdminActor> {
  try {
    return await requireAdmin(ctx);
  } catch (error) {
    throw toConvexError(error);
  }
}

async function moveOf(ctx: QueryCtx | MutationCtx, kind: Kind, key: string): Promise<MoveRow | null> {
  return await ctx.db
    .query("texChatMoves")
    .withIndex("by_chat", (q) => q.eq("kind", kind).eq("key", key))
    .unique();
}

function shown(row: MoveRow | undefined) {
  if (row === undefined) return null;
  return { status: row.status, detail: row.detail ?? null, askedAt: row.askedAt, toldAt: row.toldAt ?? null, movedAt: row.movedAt ?? null, updatedAt: row.updatedAt };
}

/** Every person and group Tex texts with, newest group first, each with its move (or none). */
export const listTexChatMoves = query({
  args: {},
  returns: listValidator,
  handler: async (ctx) => {
    await staff(ctx);
    const moves = new Map<string, MoveRow>();
    for (const row of await ctx.db.query("texChatMoves").take(MAX_LISTED * 2)) moves.set(`${row.kind}:${row.key}`, row);

    const handles = new Map<Id<"users">, string>();
    const handleOf = async (userId: Id<"users">) => {
      if (!handles.has(userId)) handles.set(userId, await handleFor(ctx, userId));
      return handles.get(userId) ?? "";
    };

    const people = [];
    for (const link of await ctx.db.query("phoneLinks").take(MAX_LISTED)) {
      if (!isPhoneNumber(link.phone)) continue;
      const user = await ctx.db.get(link.userId);
      const handle = await handleOf(link.userId);
      const name = (typeof user?.name === "string" && user.name.trim()) || (handle ? `@${handle}` : "Someone");
      people.push({ phone: link.phone, name, move: shown(moves.get(`person:${link.phone}`)) });
    }
    // People let in off the waitlist by number text Tex too, before they link an account (`textPhones.knownPhones`).
    const listed = new Set(people.map((row) => row.phone));
    const admitted = ctx.db.query("waitlist").withIndex("by_status_joinedAt", (q) => q.eq("status", "admitted"));
    for await (const row of admitted) {
      if (people.length >= MAX_LISTED) break;
      if (row.phone === undefined || !isPhoneNumber(row.phone) || listed.has(row.phone)) continue;
      listed.add(row.phone);
      people.push({ phone: row.phone, name: "Not signed up yet", move: shown(moves.get(`person:${row.phone}`)) });
    }
    people.sort((a, b) => a.name.localeCompare(b.name));

    const groups = [];
    for (const chat of await ctx.db.query("textGroups").order("desc").take(MAX_LISTED)) {
      const members = chat.homeUsers ?? [];
      const name = chat.chatName?.trim() || groupName(await Promise.all(members.map(handleOf)));
      groups.push({ groupKey: chat.groupKey, name, people: members.length, lastSeenAt: chat.lastSeenAt, move: shown(moves.get(`group:${chat.groupKey}`)) });
    }
    groups.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return { people, groups };
  },
});

/** Ask for one chat to be moved: the Worker sends its text within a minute. Asking again re-sends; a move being sent waits. */
export const askTexChatMove = mutation({
  args: { kind: kindValidator, key: v.string() },
  returns: moveValidator,
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    if (args.kind === "person" && !isPhoneNumber(args.key)) refuse("That is not a phone number.");
    if (args.kind === "group" && !GROUP_KEY.test(args.key)) refuse("That is not a group chat.");
    const setting = await ctx.db.query("texOldLine").first();
    if (!setting?.number) refuse("Save the new number on this page first, under Old number.");
    const row = await moveOf(ctx, args.kind, args.key);
    if (row?.status === "sending") refuse("That chat's text is going out now. Wait a minute and look again.");
    const now = Date.now();
    const fields = { kind: args.kind, key: args.key, status: "asked" as const, askedAt: now, askedBy: actor.userId, updatedAt: now };
    if (row === null) await ctx.db.insert("texChatMoves", fields);
    else await ctx.db.replace(row._id, { ...fields, ...(row.movedAt !== undefined ? { movedAt: row.movedAt } : {}) });
    await recordAdminAudit(ctx, actor, "tex.chat_move_asked", "tex.chat_move", { kind: args.kind });
    return { status: "asked" as const, detail: null, askedAt: now, toldAt: null, movedAt: row?.movedAt ?? null, updatedAt: now };
  },
});

// ── The Worker's side (`lib/gatewayRoutes/agentTextMoves.ts`) ──────────────

/** Up to `MOVES_PER_CLAIM` asked moves (and any the Worker took and lost), now `sending`. */
export const claimTexChatMoves = internalMutation({
  args: { now: v.number() },
  returns: v.array(v.object({ kind: kindValidator, key: v.string(), askedAt: v.number() })),
  handler: async (ctx, { now }) => {
    const asked = await ctx.db.query("texChatMoves").withIndex("by_status", (q) => q.eq("status", "asked")).take(MOVES_PER_CLAIM);
    const lost = await ctx.db.query("texChatMoves").withIndex("by_status", (q) => q.eq("status", "sending")).take(MOVES_PER_CLAIM);
    const taken = [...asked, ...lost.filter((row) => (row.claimedAt ?? 0) < now - MOVE_CLAIM_MS)].slice(0, MOVES_PER_CLAIM);
    for (const row of taken) await ctx.db.patch(row._id, { status: "sending", claimedAt: now, updatedAt: now });
    return taken.map((row) => ({ kind: row.kind, key: row.key, askedAt: row.askedAt }));
  },
});

/**
 * How a move went. `told` or `failed` answers the ask it names (`askedAt`), so a late report of an earlier ask never
 * overwrites a newer one; `moved` is the chat's first text on the new line after it was told.
 */
export const reportTexChatMove = internalMutation({
  args: { kind: kindValidator, key: v.string(), status: v.union(v.literal("told"), v.literal("moved"), v.literal("failed")), askedAt: v.optional(v.number()), detail: v.optional(v.string()), now: v.number() },
  returns: v.union(v.literal("noted"), v.literal("stale"), v.literal("no_move")),
  handler: async (ctx, args) => {
    const row = await moveOf(ctx, args.kind, args.key);
    if (row === null) return "no_move";
    const detail = args.detail === undefined ? undefined : DETAILS.has(args.detail) ? args.detail : "unknown";
    if (args.status === "moved") {
      if (row.status !== "told" && row.status !== "sending") return "stale";
      await ctx.db.patch(row._id, { status: "moved", movedAt: args.now, updatedAt: args.now, ...(detail !== undefined ? { detail } : {}) });
      return "noted";
    }
    // A group's move is told, then can still fail when the new line could not take the old number out.
    if (row.askedAt !== args.askedAt || (row.status !== "sending" && !(row.status === "told" && args.status === "failed"))) return "stale";
    await ctx.db.patch(row._id, {
      status: args.status,
      detail,
      updatedAt: args.now,
      ...(args.status === "told" ? { toldAt: args.now } : {}),
    });
    return "noted";
  },
});
