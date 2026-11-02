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
import { internalAction, internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { drainWorkspace, RETRY_MS } from "./lib/rowWatch/drain";
import { nodePaths, rowsAfter } from "./lib/nodes/paths";
import { objectRowOf } from "./lib/workspaceObjects/rows";

/** Outbox entries one round takes. */
const ENTRIES_PER_ROUND = 50;
/**
 * Rows one round reads. Entries name up to `OUTBOX_MAX_IDS` rows each, so fifty of them could name tens of thousands,
 * and a round that read them all went over Convex's per-query read limit and failed every time: the workspace's
 * outbox never drained, and every save waited on it (production, 2026-11-02). A round takes entries until it names
 * this many rows, and an entry naming more is taken in parts (`trim`), the rest left in the entry for the next round.
 */
export const ROUND_IDS = 500;
/** How long a drain holds a workspace; longer than any one round. */
export const LEASE_MS = 2 * 60 * 1000;
/** A writer's clock and a query's may differ: a mark closes only from a read this long after its writer said done. */
const MARK_CLOCK_MARGIN_MS = 2_000;

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

/** A push's failure, kept for the marks report (`workspaceObjectMarks.ts` `report`): the reason as a short code. */
export const failed = internalMutation({
  args: { workspaceId: v.id("workspaces"), reason: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, reason, now }) => {
    const code = reason.replace(/[^A-Za-z0-9 ._:-]/g, "").slice(0, 80) || "failed";
    const held = await ctx.db
      .query("workspaceObjectPushFailures")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (held === null) await ctx.db.insert("workspaceObjectPushFailures", { workspaceId, reason: code, at: now, count: 1 });
    else await ctx.db.patch(held._id, { reason: code, at: now, count: held.count + 1 });
    return null;
  },
});

/**
 * The entries the object took, gone; `true` while more wait (the lease is kept for them), else the lease is let
 * go in the same transaction, so an entry written after this commits schedules a drain that finds it free.
 */
export const ack = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    entryIds: v.array(v.id("workspaceObjectOutbox")),
    /** An entry the round took only part of: the rows it pushed leave the entry, the rest wait in it. */
    trim: v.optional(v.object({ entryId: v.id("workspaceObjectOutbox"), nodeIds: v.array(v.id("nodes")) })),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, entryIds, trim, now }) => {
    for (const id of entryIds) {
      const entry = await ctx.db.get(id);
      if (entry !== null && entry.workspaceId === workspaceId) await ctx.db.delete(id);
    }
    if (trim !== undefined) {
      const entry = await ctx.db.get(trim.entryId);
      if (entry !== null && entry.workspaceId === workspaceId) {
        const pushed = new Set<string>(trim.nodeIds);
        const rest = entry.nodeIds.filter((id) => !pushed.has(id));
        if (rest.length === 0) await ctx.db.delete(entry._id);
        else await ctx.db.patch(entry._id, { nodeIds: rest });
      }
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
      // Every entry is in: the last failure, if any, is over.
      const failure = await ctx.db
        .query("workspaceObjectPushFailures")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      if (failure !== null) await ctx.db.delete(failure._id);
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
    const waiting = await ctx.db
      .query("workspaceObjectOutbox")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
      .take(ENTRIES_PER_ROUND);
    // Oldest first, until the round names `ROUND_IDS` rows; an entry naming more than that alone is taken in part.
    const named = new Set<Id<"nodes">>();
    const entries: typeof waiting = [];
    let trim: { entryId: Id<"workspaceObjectOutbox">; nodeIds: Id<"nodes">[] } | undefined;
    for (const entry of waiting) {
      const fresh = entry.nodeIds.filter((id) => !named.has(id));
      if (named.size + fresh.length > ROUND_IDS) {
        if (entries.length === 0) {
          trim = { entryId: entry._id, nodeIds: fresh.slice(0, ROUND_IDS) };
          for (const id of trim.nodeIds) named.add(id);
        }
        break;
      }
      for (const id of fresh) named.add(id);
      entries.push(entry);
    }
    const considered = trim === undefined ? entries : waiting.filter((entry) => entry._id === trim.entryId);
    const entryIds = entries.map((entry) => entry._id);
    const access = considered.some((entry) => entry.access);
    const binding = considered.some((entry) => entry.binding === true);
    // A change that may narrow and told the object nothing first (`lib/rowWatch/mutations.ts`): the drain opens a mark
    // for it before it pushes, so a push that fails leaves the object saying behind rather than serving the old rows.
    const unmarked = considered.some((entry) => entry.unmarked === true);
    // Marks whose writer committed well before this read, when this round takes every entry still waiting: the rows
    // read here carry their change, so they close with them. A round that leaves entries behind closes none.
    const takesAll = waiting.length < ENTRIES_PER_ROUND && entries.length === waiting.length && trim === undefined;
    const close = takesAll
      ? (await ctx.db.query("workspaceObjectMarks").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect())
          .filter((mark) => mark.doneAt !== undefined && mark.doneAt <= readAt - MARK_CLOCK_MARGIN_MS)
          .map((mark) => mark.token)
      : [];
    if (considered.some((entry) => entry.all === true)) return { entryIds, trim, all: true as const, access, readAt, rows: [], removed: [], close, binding, unmarked };
    const ids = [...named];
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
    return { entryIds, trim, all: false as const, access, readAt, rows, removed, close, binding, unmarked };
  },
});

/** One page of every live row, for an entry too big to name its rows. */
export const page = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()), readAt: v.number() },
  handler: async (ctx, { workspaceId, after, readAt }) => {
    // A page reads as many rows as a round may (`ROUND_IDS`), for the same reason.
    const found = await rowsAfter(ctx.db, workspaceId, "", after, ROUND_IDS);
    const rows = found.flatMap((doc) => {
      const row = objectRowOf(doc, readAt);
      return row === null ? [] : [row];
    });
    return { rows, after: found.length < ROUND_IDS ? null : found[found.length - 1].path };
  },
});

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

/** Workspaces with an entry or a committed mark older than a retry: their drain was lost or keeps failing. */
export const stale = internalQuery({
  args: { before: v.number() },
  returns: v.array(v.id("workspaces")),
  handler: async (ctx, { before }) => {
    const seen = new Set<Id<"workspaces">>();
    for await (const entry of ctx.db.query("workspaceObjectOutbox")) {
      if (entry.at < before) seen.add(entry.workspaceId);
      if (seen.size >= 100) break;
    }
    // A mark whose change committed but which nobody closed (its writer's close failed): a drain closes it.
    for await (const mark of ctx.db.query("workspaceObjectMarks")) {
      if (seen.size >= 100) break;
      if (mark.doneAt !== undefined && mark.doneAt < before) seen.add(mark.workspaceId);
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
    await ctx.runMutation(internal.functions.workspaceObjectMarks.prune, { now: Date.now() });
    await ctx.runMutation(internal.functions.workspaceObjectMarks.pruneUnmarked, { now: Date.now() });
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

// What actions wait on, from where it lives (`lib/rowWatch/drain.ts`), for the callers that import it from here.
export { drainWorkspace, GATEWAY_SETTLE, objectSettled, RETRY_MS, SETTLE_MS, settledAfter } from "./lib/rowWatch/drain";
