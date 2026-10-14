/**
 * The move queue's internal functions (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`): a move of any size is one
 * `moveQueue` row, the tree draws it the moment the row is `moving`
 * (`lib/nodes/moveOverlay.ts`), and scheduled passes copy the bucket behind
 * it (`lib/nodes/moveWork.ts`), oldest move first.
 *
 * Every function is internal. A move is started through the credential
 * barrier (`lib/nodes/moveStart.ts`), which has already decided the caller may
 * make it; staff's Retry and Undo are in `nodeMovesAdmin.ts`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { readMirror, treeServesNow } from "./lib/nodes/listing";
import { migrationPaused } from "./lib/nodes/pause";
import { MOVES_PER_WORKSPACE, pendingMoves } from "./lib/nodes/moveOverlay";
import { MOVE_LEASE_MS, moveRetryDelay, movesOverlap } from "./lib/nodes/moveRules";
import { blendRate } from "./lib/nodes/moveLag";
import { scheduleStorageLagAlert } from "./storageLag";
import { freshenMeaningAfterActivity } from "./lib/meaningFns/rows";
import { followMovesForMembers } from "./lib/placesFollow";
import { markWebsiteMoved } from "./lib/websites/routeChangeAt";

const ruleListValidator = v.object({
  folders: v.array(v.object({ prefix: v.string(), visibility: v.string(), was: v.optional(v.string()) })),
  notes: v.array(v.object({ path: v.string(), visibility: v.string(), was: v.optional(v.string()) })),
});

const moveValidator = v.object({ from: v.string(), to: v.string() });

/** Schedule one worker pass for the workspace's oldest move. */
async function scheduleWork(ctx: MutationCtx, workspaceId: Id<"workspaces">, delayMs = 0): Promise<void> {
  const delay = Math.max(0, delayMs);
  await ctx.scheduler.runAfter(delay, internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "nodesMoveWork" },
  });
}

async function queueOf(ctx: { db: MutationCtx["db"] }, workspaceId: Id<"workspaces">): Promise<Doc<"moveQueue">[]> {
  return await ctx.db
    .query("moveQueue")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MOVES_PER_WORKSPACE * 2);
}

/** The moves the tree draws already, oldest first: what a request's store folds through. */
export const active = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(moveValidator),
  handler: async (ctx, { workspaceId }) => await pendingMoves(ctx.db, workspaceId),
});

/**
 * Live rows at one bucket key and under it, in key order from just after
 * `after`: a move's inventory, read a page at a time.
 */
export const rowsUnder = internalQuery({
  args: { workspaceId: v.id("workspaces"), path: v.string(), after: v.optional(v.string()), limit: v.number() },
  returns: v.object({
    rows: v.array(v.object({ path: v.string(), kind: v.union(v.literal("file"), v.literal("folder")) })),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { workspaceId, path, after, limit }) => {
    const size = Math.max(1, Math.min(Math.floor(limit), 2_000));
    const rows: { path: string; kind: "file" | "folder" }[] = [];
    const exact = after === undefined
      ? await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
        .unique()
      : null;
    if (exact !== null && exact.goneAt === undefined) rows.push({ path: exact.path, kind: exact.kind });
    const prefix = `${path}/`;
    const start = after !== undefined && after > prefix ? after : prefix;
    const query = ctx.db.query("nodes").withIndex("by_workspace_path", (q) => {
      const scoped = q.eq("workspaceId", workspaceId);
      return start === prefix && after === undefined ? scoped.gte("path", prefix) : scoped.gt("path", start);
    });
    let last: string | null = null;
    let scanned = 0;
    for await (const doc of query) {
      if (!doc.path.startsWith(prefix)) return { rows, cursor: null };
      last = doc.path;
      scanned += 1;
      if (doc.goneAt === undefined) rows.push({ path: doc.path, kind: doc.kind });
      if (scanned >= size) return { rows, cursor: last };
    }
    return { rows, cursor: null };
  },
});

/**
 * Hold `from` and `to` for a move about to be made. `not_served` and `busy`
 * send the caller the old way; `reserved` means the names are part of a move
 * still running, and the caller is told to wait rather than moved the old way.
 */
export const reserve = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    from: v.string(),
    to: v.string(),
    scope: v.union(v.literal("private"), v.literal("team")),
    grantedNames: v.array(v.string()),
    actorUserId: v.optional(v.id("users")),
    /** A move into the hidden trash (`lib/nodes/trashStart.ts`). */
    trash: v.optional(v.boolean()),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), id: v.id("moveQueue"), moves: v.array(moveValidator) }),
    v.object({ ok: v.literal(false), reason: v.union(v.literal("not_served"), v.literal("busy"), v.literal("reserved")) }),
  ),
  handler: async (ctx, args) => {
    const queue = await queueOf(ctx, args.workspaceId);
    // Moved the old way, a move that shares a name with a queued one would act on the bucket's
    // layout rather than the tree's. It waits instead.
    const overlaps = queue.some((row) => movesOverlap(row, args));
    const refuse = (reason: "not_served" | "busy") => ({ ok: false as const, reason: overlaps ? "reserved" as const : reason });
    // Staff's Pause stops background copying, so a folder moves in one go while it holds.
    if (!(await treeServesNow(ctx.db, args.workspaceId)) || (await migrationPaused(ctx.db))) return refuse("not_served");
    if (queue.length >= MOVES_PER_WORKSPACE) return refuse("busy");
    // A move still being prepared is not drawn yet, so nothing may be moved into or out of its names.
    // A drawn one may be moved onward from where it now is (a chain), but nothing may be moved
    // out of, onto, into or over a name it is still carrying away: those names are reserved.
    for (const row of queue) {
      const clash = row.state === "preparing"
        ? movesOverlap(row, args)
        : movesOverlap({ from: row.from, to: row.from }, args);
      if (clash) return { ok: false as const, reason: "reserved" as const };
    }
    const moves = queue.filter((row) => row.state === "moving").map((row) => ({ from: row.from, to: row.to }));
    const id = await ctx.db.insert("moveQueue", {
      workspaceId: args.workspaceId,
      from: args.from,
      to: args.to,
      kind: "file",
      state: "preparing",
      ...(args.actorUserId === undefined ? {} : { actorUserId: args.actorUserId }),
      ...(args.trash === true ? { trash: true } : {}),
      scope: args.scope,
      grantedNames: args.grantedNames,
      total: 0,
      moved: 0,
      added: { folders: [], notes: [] },
      attempts: 0,
      nextAt: args.now,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return { ok: true as const, id, moves };
  },
});

/** Let go of a reservation that was never drawn. */
export const release = internalMutation({
  args: { id: v.id("moveQueue") },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    const row = await ctx.db.get(id);
    if (row !== null && row.state === "preparing") await ctx.db.delete(id);
    return null;
  },
});

/**
 * Draw the move: from here every listing shows it. Refused (and the
 * reservation dropped) when the tree stopped serving, or when the tree's copy
 * of the rules is not the `privacy.md` the move's rules were written into, so
 * the moved names are never judged by rules from before the move.
 */
export const activate = internalMutation({
  args: {
    id: v.id("moveQueue"),
    kind: v.union(v.literal("file"), v.literal("folder")),
    total: v.number(),
    added: ruleListValidator,
    privacyEtag: v.union(v.string(), v.null()),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null || row.state !== "preparing") return false;
    const mirror = await readMirror(ctx.db, row.workspaceId);
    // A trash writes no rules: its names are hidden plumbing nobody is shown.
    const rulesCurrent = row.trash === true || (mirror?.etag ?? null) === args.privacyEtag;
    if (!rulesCurrent || !(await treeServesNow(ctx.db, row.workspaceId))) {
      await ctx.db.delete(args.id);
      return false;
    }
    await ctx.db.patch(args.id, {
      state: "moving",
      kind: args.kind,
      total: args.total,
      added: args.added,
      nextAt: args.now,
      updatedAt: args.now,
    });
    // Every screen draws the new name from here, so pins and recents go there now (`placesFollow.ts`).
    // A trashed note's stay at its name, as a trash made in one go leaves them, for Restore to find.
    if (row.trash !== true) await followMovesForMembers(ctx, row.workspaceId, [{ from: row.from, to: row.to }], mirror);
    // The pages it carries are at new names for every reader now, the site's scan included.
    await markWebsiteMoved(ctx, row.workspaceId, row);
    await scheduleWork(ctx, row.workspaceId);
    return true;
  },
});

const claimValidator = v.union(
  v.null(),
  v.object({
    id: v.id("moveQueue"),
    from: v.string(),
    to: v.string(),
    kind: v.union(v.literal("file"), v.literal("folder")),
    undone: v.boolean(),
    trash: v.boolean(),
    scope: v.union(v.literal("private"), v.literal("team")),
    grantedNames: v.array(v.string()),
    added: ruleListValidator,
    /** Every drawn move, oldest first, this one included: objects go straight to where they end up. */
    moves: v.array(moveValidator),
  }),
);

/**
 * Take the workspace's oldest drawn move for one pass, when it is due and no
 * other pass holds it. Only the oldest: its old names are real bucket keys,
 * which a later move's are not until the earlier ones have finished.
 */
export const claim = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: claimValidator,
  handler: async (ctx, { workspaceId, now }) => {
    const moving = (await queueOf(ctx, workspaceId)).filter((row) => row.state === "moving");
    const oldest = moving[0];
    if (oldest === undefined) return null;
    if (oldest.nextAt > now) return null;
    if (oldest.leaseAt !== undefined && now - oldest.leaseAt < MOVE_LEASE_MS) return null;
    await ctx.db.patch(oldest._id, { leaseAt: now });
    return {
      id: oldest._id,
      from: oldest.from,
      to: oldest.to,
      kind: oldest.kind,
      undone: oldest.undone === true,
      trash: oldest.trash === true,
      scope: oldest.scope,
      grantedNames: oldest.grantedNames,
      added: oldest.added,
      moves: moving.map((row) => ({ from: row.from, to: row.to })),
    };
  },
});

/**
 * Restore asked for a note whose trash is still queued (`trash` to `path`):
 * the move is turned around, as staff's Undo turns a move around, and the
 * tree draws the note back at once. `busy` while a pass holds it (the caller
 * waits a moment and asks again); `none` when no such move is queued, and the
 * trash is restored from the bucket the usual way.
 */
export const undoTrash = internalMutation({
  args: { workspaceId: v.id("workspaces"), trash: v.string(), path: v.string(), now: v.number() },
  returns: v.union(v.literal("undone"), v.literal("busy"), v.literal("none")),
  handler: async (ctx, { workspaceId, trash, path, now }) => {
    const row = (await queueOf(ctx, workspaceId)).find(
      (candidate) => candidate.trash === true && candidate.undone !== true && candidate.from === path && candidate.to === trash,
    );
    if (row === undefined) return "none" as const;
    if (row.state !== "moving" || (row.leaseAt !== undefined && now - row.leaseAt < MOVE_LEASE_MS)) return "busy" as const;
    await ctx.db.patch(row._id, {
      from: row.to,
      to: row.from,
      undone: true,
      moved: 0,
      attempts: 0,
      lastError: undefined,
      nextAt: now,
      updatedAt: now,
    });
    await markWebsiteMoved(ctx, workspaceId, { from: row.to, to: row.from });
    await scheduleWork(ctx, workspaceId);
    return "undone" as const;
  },
});

/** A pass moved `moved` objects; the next one starts at once. */
export const progress = internalMutation({
  args: { id: v.id("moveQueue"), moved: v.number(), now: v.number(), ms: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { id, moved, now, ms }): Promise<null> => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    const count = Math.max(0, Math.floor(moved));
    const rate = ms === undefined ? row.rate : blendRate(row.rate, count, ms);
    await ctx.db.patch(id, {
      moved: row.moved + count,
      ...(rate === undefined ? {} : { rate }),
      attempts: 0,
      lastError: undefined,
      leaseAt: undefined,
      nextAt: now,
      updatedAt: now,
    });
    await scheduleWork(ctx, row.workspaceId);
    return null;
  },
});

/** Objects a request moved early (a note opened at its new name). Counts only; schedules nothing. */
export const promoted = internalMutation({
  args: { workspaceId: v.id("workspaces"), from: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, from, now }): Promise<null> => {
    for (const row of await queueOf(ctx, workspaceId)) {
      if (row.state !== "moving") continue;
      if (from !== row.from && !from.startsWith(`${row.from}/`)) continue;
      await ctx.db.patch(row._id, { moved: row.moved + 1, updatedAt: now });
      return null;
    }
    return null;
  },
});

/**
 * A pass failed with a fixed, path-free label. The move is retried after a
 * back-off, for ever: a move is never undone on its own (staff can Undo it).
 */
export const failed = internalMutation({
  args: { id: v.id("moveQueue"), label: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { id, label, now }): Promise<null> => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    const attempts = row.attempts + 1;
    const delay = moveRetryDelay(attempts);
    await ctx.db.patch(id, { attempts, lastError: label, leaseAt: undefined, nextAt: now + delay, updatedAt: now });
    await scheduleWork(ctx, row.workspaceId, delay);
    return null;
  },
});

/** The move's last object has moved and its rules are settled: the row goes, and the next move starts. */
export const complete = internalMutation({
  args: { id: v.id("moveQueue") },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    await ctx.db.delete(id);
    // Staff were told it fell behind: tell them it caught up.
    if (row.lateAt !== undefined) await scheduleStorageLagAlert(ctx, { kind: "recovered", workspaceId: row.workspaceId, tookMs: Date.now() - row.createdAt });
    // The copy is done and the old name's rules are gone: the site is rebuilt from where its pages now sit.
    await markWebsiteMoved(ctx, row.workspaceId, row);
    // Search by meaning holds the notes at their old names, which it no longer folds: catch it up.
    await freshenMeaningAfterActivity(ctx, row.workspaceId);
    const rest = (await queueOf(ctx, row.workspaceId)).filter((other) => other.state === "moving");
    if (rest.length > 0) await scheduleWork(ctx, row.workspaceId);
    return null;
  },
});

/**
 * The safety net (`crons.ts`): a move whose chain of passes stopped (a
 * deployment, a lost schedule) is picked up again once its lease has lapsed.
 */
export const resume = internalMutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("moveQueue")
      .withIndex("by_next", (q) => q.lte("nextAt", now))
      .take(200);
    const started = new Set<string>();
    for (const row of due) {
      if (row.state !== "moving" || started.has(row.workspaceId)) continue;
      if (row.leaseAt !== undefined && now - row.leaseAt < MOVE_LEASE_MS) continue;
      started.add(row.workspaceId);
      await scheduleWork(ctx, row.workspaceId);
    }
    // A reservation whose start never finished (the action died) is dropped.
    for (const row of due) {
      if (row.state === "preparing" && now - row.createdAt > MOVE_LEASE_MS) await ctx.db.delete(row._id);
    }
    return { started: started.size };
  },
});
