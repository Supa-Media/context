/**
 * Places: what the caller pinned to Home, and which folders they open most.
 *
 * Paths and counts, never note text, and only ever the caller's own rows —
 * nothing here takes a user id. A workspace the caller is not in answers
 * exactly like one that does not exist. The tables and the rules that keep
 * them honest (moves, sweeps) are in `lib/schema/places.ts` and `lib/places.ts`.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type QueryCtx } from "../_generated/server";
import { normalizePath } from "./lib/fileOps/paths";
import {
  OPEN_ROWS_PER_WORKSPACE,
  PINS_PER_WORKSPACE,
  daysInWindow,
  dayOf,
  retargetPlaces as retarget,
} from "./lib/places";
import { requireWorkspaceAccess } from "./lib/workspaceAuth";

const kindValidator = v.union(v.literal("note"), v.literal("folder"));

const pinValidator = v.object({ path: v.string(), kind: kindValidator, pinnedAt: v.number() });

const openedValidator = v.object({
  path: v.string(),
  /** Opens in the window. */
  opens: v.number(),
  /** Distinct days in the window with at least one open. */
  daysOpened: v.number(),
  lastAt: v.number(),
});

function refuse(message: string): never {
  throw new ConvexError({ code: "INVALID_PLACE", message });
}

function placePath(input: string): string {
  const path = normalizePath(input);
  if (path === null) refuse("Not a path");
  return path;
}

/** The caller, if signed in and a member of `workspaceId`; throws for a non-member. */
async function readerIn(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Id<"users"> | null> {
  const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
  if (userId === null) return null;
  await requireWorkspaceAccess(ctx, workspaceId, userId);
  return userId;
}

async function writerIn(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Id<"users">> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceAccess(ctx, workspaceId, userId);
  return userId;
}

async function myPins(ctx: QueryCtx, userId: Id<"users">, workspaceId: Id<"workspaces">) {
  const rows = await ctx.db
    .query("placePins")
    .withIndex("by_user_workspace", (q) => q.eq("userId", userId).eq("workspaceId", workspaceId))
    .collect();
  return rows.sort((a, b) => a.order - b.order || a.pinnedAt - b.pinnedAt);
}

/** The caller's pins in one workspace, in Home order; empty when signed out. */
export const listPins = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(pinValidator),
  handler: async (ctx, args) => {
    const userId = await readerIn(ctx, args.workspaceId);
    if (userId === null) return [];
    return (await myPins(ctx, userId, args.workspaceId)).map(({ path, kind, pinnedAt }) => ({ path, kind, pinnedAt }));
  },
});

/** Pin a note or folder to the end of Home. Pinning it again changes nothing. */
export const pin = mutation({
  args: { workspaceId: v.id("workspaces"), path: v.string(), kind: kindValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await writerIn(ctx, args.workspaceId);
    const path = placePath(args.path);
    const pins = await myPins(ctx, userId, args.workspaceId);
    if (pins.some((row) => row.path === path)) return null;
    if (pins.length >= PINS_PER_WORKSPACE) refuse(`Home holds ${PINS_PER_WORKSPACE} pins; unpin one first`);
    const last = pins.at(-1)?.order ?? -1;
    await ctx.db.insert("placePins", {
      userId,
      workspaceId: args.workspaceId,
      path,
      kind: args.kind,
      order: last + 1,
      pinnedAt: Date.now(),
    });
    return null;
  },
});

export const unpin = mutation({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await writerIn(ctx, args.workspaceId);
    const path = placePath(args.path);
    for (const row of await myPins(ctx, userId, args.workspaceId)) {
      if (row.path === path) await ctx.db.delete(row._id);
    }
    return null;
  },
});

/**
 * Put the named pins first, in the order given; the rest keep their order
 * after them. Paths that are not pinned are ignored.
 */
export const reorderPins = mutation({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await writerIn(ctx, args.workspaceId);
    if (args.paths.length > PINS_PER_WORKSPACE) refuse("Too many paths");
    const wanted = args.paths.map(placePath);
    const pins = await myPins(ctx, userId, args.workspaceId);
    const byPath = new Map(pins.map((row) => [row.path, row]));
    const first = [...new Set(wanted)].flatMap((path) => byPath.get(path) ?? []);
    const rest = pins.filter((row) => !first.includes(row));
    let order = 0;
    for (const row of [...first, ...rest]) {
      if (row.order !== order) await ctx.db.patch(row._id, { order });
      order += 1;
    }
    return null;
  },
});

/** Count one open of a folder today. A trailing slash is the same folder. */
export const recordOpen = mutation({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await writerIn(ctx, args.workspaceId);
    const path = placePath(args.path);
    const now = Date.now();
    const today = dayOf(now);
    const row = await ctx.db
      .query("placeOpens")
      .withIndex("by_user_workspace_path", (q) =>
        q.eq("userId", userId).eq("workspaceId", args.workspaceId).eq("path", path),
      )
      .first();
    if (row !== null) {
      const days = daysInWindow(row.days, today);
      const current = days.find((entry) => entry.day === today);
      if (current) current.n += 1;
      else days.push({ day: today, n: 1 });
      await ctx.db.patch(row._id, { days, lastAt: now });
      return null;
    }
    const rows = await ctx.db
      .query("placeOpens")
      .withIndex("by_user_workspace", (q) => q.eq("userId", userId).eq("workspaceId", args.workspaceId))
      .collect();
    if (rows.length >= OPEN_ROWS_PER_WORKSPACE) {
      const stalest = rows
        .sort((a, b) => a.lastAt - b.lastAt)
        .slice(0, rows.length - OPEN_ROWS_PER_WORKSPACE + 1);
      for (const old of stalest) await ctx.db.delete(old._id);
    }
    await ctx.db.insert("placeOpens", {
      userId,
      workspaceId: args.workspaceId,
      path,
      days: [{ day: today, n: 1 }],
      lastAt: now,
    });
    return null;
  },
});

/** The caller's folders by opens in the last 14 days, busiest first; empty when signed out. */
export const mostOpened = query({
  args: { workspaceId: v.id("workspaces"), limit: v.optional(v.number()) },
  returns: v.array(openedValidator),
  handler: async (ctx, args) => {
    const userId = await readerIn(ctx, args.workspaceId);
    if (userId === null) return [];
    const today = dayOf(Date.now());
    const rows = await ctx.db
      .query("placeOpens")
      .withIndex("by_user_workspace", (q) => q.eq("userId", userId).eq("workspaceId", args.workspaceId))
      .collect();
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 20), OPEN_ROWS_PER_WORKSPACE));
    return rows
      .map((row) => {
        const days = daysInWindow(row.days, today);
        return {
          path: row.path,
          opens: days.reduce((sum, entry) => sum + entry.n, 0),
          daysOpened: days.length,
          lastAt: row.lastAt,
        };
      })
      .filter((row) => row.opens > 0)
      .sort((a, b) => b.opens - a.opens || b.lastAt - a.lastAt)
      .slice(0, limit);
  },
});

/** Called by the app's moves (`lib/filesFns/entries.ts`) once storage has moved. */
export const retargetPlaces = internalMutation({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const from = normalizePath(args.from);
    const to = normalizePath(args.to);
    if (from === null || to === null) return null;
    await retarget(ctx, args.workspaceId, from, to);
    return null;
  },
});
