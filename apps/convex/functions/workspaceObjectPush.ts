/**
 * Row and access changes, carried from Convex to the workspace's object (`lib/rowWatch/`).
 *
 * Every mutation that writes a workspace's rows or access, for a workspace judged in its object, leaves an outbox
 * entry and schedules `drain`. One drain at a time holds a workspace (a lease), so its pushes leave in the order
 * they were read: each round reads the named rows as they stand now (built paths, `lib/nodes/paths.ts`), renders
 * the access rules for each audience if they may have changed, and sends them in one call stamped with that read
 * time. The object keeps a row only from a newer clock and rules only from a newer access version, so a replay can
 * never roll anything back. An entry leaves the outbox only after the object took it.
 *
 * A push that fails leaves its entries; the lease is let go and the drain is tried again (`RETRY_MS`), and the
 * minute sweep picks up any workspace whose entries wait longer than that.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type ActionCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { objectDoor } from "./lib/rowWatch/objectDoor";
import { nodePaths, rowsAfter } from "./lib/nodes/paths";
import { objectRowOf } from "./lib/workspaceObjects/rows";

/** Outbox entries one round takes. */
const ENTRIES_PER_ROUND = 50;
/** Rounds one drain runs before handing on to a fresh one. */
const ROUNDS_PER_DRAIN = 20;
/** Rows per object call: the object's `MAX_ROWS_PER_PUT`. */
const ROWS_PER_CALL = 2_000;
/** How long a drain holds a workspace; longer than any one round. */
export const LEASE_MS = 2 * 60 * 1000;
/** How soon a failed push is tried again. */
export const RETRY_MS = 30 * 1000;

type ObjectRow = NonNullable<ReturnType<typeof objectRowOf>>;

/** Take the workspace for one drain, or `false` while another holds it. */
export const claim = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, now }) => {
    const held = await ctx.db
      .query("workspaceObjectPushLeases")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (held !== null && held.until > now) return false;
    if (held === null) await ctx.db.insert("workspaceObjectPushLeases", { workspaceId, until: now + LEASE_MS });
    else await ctx.db.patch(held._id, { until: now + LEASE_MS });
    return true;
  },
});

/** Let the workspace go, after a failure. */
export const release = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const held = await ctx.db
      .query("workspaceObjectPushLeases")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (held !== null) await ctx.db.delete(held._id);
    return null;
  },
});

/**
 * The entries the object took, gone; `true` while more wait (the lease is kept for them), else the lease is let
 * go in the same transaction, so an entry written after this commits schedules a drain that finds it free.
 */
export const ack = internalMutation({
  args: { workspaceId: v.id("workspaces"), entryIds: v.array(v.id("workspaceObjectOutbox")), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, entryIds, now }) => {
    for (const id of entryIds) {
      const entry = await ctx.db.get(id);
      if (entry !== null && entry.workspaceId === workspaceId) await ctx.db.delete(id);
    }
    const next = await ctx.db
      .query("workspaceObjectOutbox")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
      .first();
    const held = await ctx.db
      .query("workspaceObjectPushLeases")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (next === null) {
      if (held !== null) await ctx.db.delete(held._id);
      return false;
    }
    if (held !== null) await ctx.db.patch(held._id, { until: now + LEASE_MS });
    return true;
  },
});

/** One round: the oldest entries, and the rows they name as they stand now. */
export const pending = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const readAt = Date.now();
    const entries = await ctx.db
      .query("workspaceObjectOutbox")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
      .take(ENTRIES_PER_ROUND);
    const entryIds = entries.map((entry) => entry._id);
    const access = entries.some((entry) => entry.access);
    if (entries.some((entry) => entry.all === true)) return { entryIds, all: true as const, access, readAt, rows: [], removed: [] };
    const ids = [...new Set(entries.flatMap((entry) => entry.nodeIds))];
    const paths = await nodePaths(ctx.db, workspaceId);
    const rows: ObjectRow[] = [];
    const removed: string[] = [];
    for (const id of ids) {
      const doc = await ctx.db.get(id);
      const path = doc === null || doc.workspaceId !== workspaceId ? null : await paths.pathOf(doc);
      // A row whose parents spell no path is judged nowhere: it leaves the object, which fails closed.
      const row = doc === null || path === null ? null : objectRowOf({ ...doc, path }, readAt);
      if (row === null) removed.push(id);
      else rows.push(row);
    }
    return { entryIds, all: false as const, access, readAt, rows, removed };
  },
});

/** One page of every live row, for an entry too big to name its rows. */
export const page = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()), readAt: v.number() },
  handler: async (ctx, { workspaceId, after, readAt }) => {
    const found = await rowsAfter(ctx.db, workspaceId, "", after, ROWS_PER_CALL);
    const rows = found.flatMap((doc) => {
      const row = objectRowOf(doc, readAt);
      return row === null ? [] : [row];
    });
    return { rows, after: found.length < ROWS_PER_CALL ? null : found[found.length - 1].path };
  },
});

type Call = ReturnType<typeof objectDoor>;

async function pushRound(
  ctx: ActionCtx,
  call: Call,
  workspaceId: Id<"workspaces">,
  round: { all: boolean; access: boolean; readAt: number; rows: ObjectRow[]; removed: string[] },
): Promise<void> {
  const rules = round.access
    ? {
        member: await ctx.runQuery(internal.functions.nodesPrivacy.authority, { workspaceId, audience: "member" }),
        guest: await ctx.runQuery(internal.functions.nodesPrivacy.authority, { workspaceId, audience: "guest" }),
      }
    : null;
  if (round.all) {
    // The whole set, staged in pages and swapped in on the last, so a row the tree no longer has leaves.
    const epoch = `push-${round.readAt}`;
    let after: string | undefined = undefined;
    for (;;) {
      const next: { rows: ObjectRow[]; after: string | null } = await ctx.runQuery(internal.functions.workspaceObjectPush.page, {
        workspaceId,
        after,
        readAt: round.readAt,
      });
      const last = next.after === null;
      await call("ws.rows.snapshot", { epoch, rows: next.rows, last, mode: "replace" });
      if (last) break;
      after = next.after ?? undefined;
    }
    if (rules !== null) await call("ws.apply", { rows: [], removed: [], at: round.readAt, rules });
    return;
  }
  // Rows and rules in one call: a move changes both, and the object must never judge new paths by old rules.
  for (let at = 0; at < Math.max(round.rows.length, round.removed.length, 1); at += ROWS_PER_CALL) {
    const first = at === 0;
    await call("ws.apply", {
      rows: round.rows.slice(at, at + ROWS_PER_CALL),
      removed: round.removed.slice(at, at + ROWS_PER_CALL),
      at: round.readAt,
      ...(first && rules !== null ? { rules } : {}),
    });
  }
}

/**
 * Carry the workspace's waiting changes to its object, now. What an action that narrows access awaits before it
 * answers, so nothing reports success while the object could still show what was taken away. `"busy"`: another
 * drain holds the workspace and will carry them; `"done"`: none wait.
 */
export async function drainWorkspace(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  options: Parameters<typeof objectDoor>[2] = {},
): Promise<"done" | "busy" | "more"> {
  if (!(await ctx.runMutation(internal.functions.workspaceObjectPush.claim, { workspaceId, now: Date.now() }))) return "busy";
  const call = objectDoor(ctx, workspaceId, options);
  try {
    for (let round = 0; round < ROUNDS_PER_DRAIN; round += 1) {
      const next = await ctx.runQuery(internal.functions.workspaceObjectPush.pending, { workspaceId });
      if (next.entryIds.length > 0) await pushRound(ctx, call, workspaceId, next);
      const more = await ctx.runMutation(internal.functions.workspaceObjectPush.ack, {
        workspaceId,
        entryIds: next.entryIds,
        now: Date.now(),
      });
      if (!more) return "done";
    }
  } catch (error) {
    await ctx.runMutation(internal.functions.workspaceObjectPush.release, { workspaceId });
    await ctx.scheduler.runAfter(RETRY_MS, internal.functions.workspaceObjectPush.drain, { workspaceId });
    console.warn(JSON.stringify({ event: "workspace_object_push_failed", workspaceId, reason: error instanceof Error ? error.message : "failed" }));
    throw error;
  }
  await ctx.runMutation(internal.functions.workspaceObjectPush.release, { workspaceId });
  await ctx.scheduler.runAfter(0, internal.functions.workspaceObjectPush.drain, { workspaceId });
  return "more";
}

export const drain = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    try {
      await drainWorkspace(ctx, workspaceId);
    } catch {
      // Logged and retried by `drainWorkspace`.
    }
    return null;
  },
});

/** Workspaces with an entry older than a retry: their drain was lost or keeps failing. */
export const stale = internalQuery({
  args: { before: v.number() },
  returns: v.array(v.id("workspaces")),
  handler: async (ctx, { before }) => {
    const seen = new Set<Id<"workspaces">>();
    for await (const entry of ctx.db.query("workspaceObjectOutbox")) {
      if (entry.at < before) seen.add(entry.workspaceId);
      if (seen.size >= 100) break;
    }
    return [...seen];
  },
});

/** The minute sweep (`crons.ts`). */
export const sweep = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const workspaceId of await ctx.runQuery(internal.functions.workspaceObjectPush.stale, { before: Date.now() - RETRY_MS })) {
      await ctx.scheduler.runAfter(0, internal.functions.workspaceObjectPush.drain, { workspaceId });
    }
    return null;
  },
});

/** Whether an entry written at or before `at` still waits for this workspace's object. */
export const waitingSince = internalQuery({
  args: { workspaceId: v.id("workspaces"), at: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, at }) => {
    const oldest = await ctx.db
      .query("workspaceObjectOutbox")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId).lte("at", at))
      .first();
    return oldest !== null;
  },
});

/** How long an action that narrowed access waits for the object before it answers anyway, and says so in the log. */
export const SETTLE_MS = 10_000;
const SETTLE_POLL_MS = 150;
/** Entries stamped this far after the action's clock still count as the action's own: the mutation's clock may lead. */
const CLOCK_MARGIN_MS = 2_000;

/**
 * Wait until every change written before now has reached the workspace's object: what an action that narrowed
 * access calls after its mutation and before it answers. `true` at once for a workspace not judged in its object
 * (it has no outbox). `false` past `SETTLE_MS`, logged: the change is kept and the push goes on retrying.
 */
export async function objectSettled(ctx: ActionCtx, workspaceId: Id<"workspaces">, settleMs = SETTLE_MS): Promise<boolean> {
  try {
    return await settle(ctx, workspaceId, settleMs);
  } catch (error) {
    // Never the caller's failure: its change is kept, and the push goes on retrying.
    console.warn(JSON.stringify({ event: "workspace_object_settle_failed", workspaceId, reason: error instanceof Error ? error.message : "failed" }));
    return false;
  }
}

async function settle(ctx: ActionCtx, workspaceId: Id<"workspaces">, settleMs: number): Promise<boolean> {
  const started = Date.now();
  const since = started + CLOCK_MARGIN_MS;
  for (;;) {
    if (!(await ctx.runQuery(internal.functions.workspaceObjectPush.waitingSince, { workspaceId, at: since }))) return true;
    try {
      await drainWorkspace(ctx, workspaceId);
    } catch {
      // Logged and retried by `drainWorkspace`.
    }
    if (!(await ctx.runQuery(internal.functions.workspaceObjectPush.waitingSince, { workspaceId, at: since }))) return true;
    if (Date.now() - started > settleMs) {
      console.warn(JSON.stringify({ event: "workspace_object_narrowing_late", workspaceId, waitedMs: Date.now() - started }));
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

/** `result`, once the changes before it reached the workspace's object: for an action that moved, hid or narrowed. */
export async function settledAfter<T>(ctx: ActionCtx, workspaceId: Id<"workspaces">, result: T): Promise<T> {
  await objectSettled(ctx, workspaceId);
  return result;
}
