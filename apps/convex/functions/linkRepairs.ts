/**
 * Links follow a move in the background (`paths-on-read.md`, "Links follow a move in the background").
 *
 * A keyed move is a row change (`lib/nodes/rowMoveStart.ts`), and the links to what moved, and the
 * relative links inside it, used to be rewritten in the same request, a read of every note that could hold
 * one: that was most of a big move's time, and a console move did not do it at all. Now the move queues its
 * files here (`enqueue`) and answers; a pass (`repairWorkspace`) takes the workspace's entries oldest first
 * and runs each through the credential barrier as the owner (`lib/nodes/linkRepair.ts`). Meanwhile, and for
 * any entry dropped after `REPAIR_ATTEMPTS`, the forwarding ledger the move wrote sends an old link on.
 *
 * One pass at a time per workspace (`leaseAt` on the entry it holds), so two passes never rewrite one note
 * at once. A half-hourly cron (`repairDue`) starts a pass wherever entries wait with none running.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { expandFolder } from "./lib/nodes/folderLinks";

/** Files one entry carries: a page of a move, well inside one rewrite's reach. */
export const REPAIR_PAIRS = 200;
/** Passes one entry gets before it is dropped. */
export const REPAIR_ATTEMPTS = 5;
/** A pass holds its workspace's queue this long; one that stopped is taken over after it. */
export const REPAIR_LEASE_MS = 10 * 60 * 1000;
/** Entries one pass works through before it hands on to the next. */
const ENTRIES_PER_PASS = 10;
/** Entries one cron tick looks at. */
const DUE_PAGE = 200;

const pair = v.object({ from: v.string(), to: v.string() });

async function queueOf(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<Doc<"linkRepairs">[]> {
  return await ctx.db
    .query("linkRepairs")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(REPAIR_ATTEMPTS + ENTRIES_PER_PASS);
}

const leased = (entry: Doc<"linkRepairs">, now: number) => entry.leaseAt !== undefined && now - entry.leaseAt < REPAIR_LEASE_MS;

/** Queue the files a move carried, a page to an entry, and start a pass. A move of nothing queues nothing. */
export const enqueue = internalMutation({
  args: { workspaceId: v.id("workspaces"), pairs: v.array(pair), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, pairs, now }) => {
    const moved = pairs.filter((entry) => entry.from !== entry.to);
    if (moved.length === 0) return null;
    for (let at = 0; at < moved.length; at += REPAIR_PAIRS) {
      await ctx.db.insert("linkRepairs", { workspaceId, pairs: moved.slice(at, at + REPAIR_PAIRS), attempts: 0, createdAt: now });
    }
    await ctx.scheduler.runAfter(0, internal.functions.linkRepairs.repairWorkspace, { workspaceId });
    return null;
  },
});

/**
 * The oldest entry, held for this pass; `null` when the queue is empty or another pass holds it. An entry
 * that has used its attempts is dropped on the way.
 */
export const claim = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.union(v.null(), v.object({ id: v.id("linkRepairs"), pairs: v.array(pair) })),
  handler: async (ctx, { workspaceId, now }) => {
    const queue = await queueOf(ctx, workspaceId);
    if (queue.some((entry) => leased(entry, now))) return null;
    for (const queued of queue) {
      // A folder moved on built paths names its row, not its files: its next page becomes the entry taken now.
      const entry = queued.folder === undefined ? queued : await expandFolder(ctx, queued, now);
      if (entry === null) continue;
      if (entry.attempts >= REPAIR_ATTEMPTS) {
        console.warn(JSON.stringify({ event: "linkRepairs.dropped", workspaceId, files: entry.pairs.length, error: entry.error ?? null }));
        await ctx.db.delete(entry._id);
        continue;
      }
      await ctx.db.patch(entry._id, { leaseAt: now, attempts: entry.attempts + 1 });
      return { id: entry._id, pairs: entry.pairs };
    }
    return null;
  },
});

export const finish = internalMutation({
  args: { id: v.id("linkRepairs") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if ((await ctx.db.get(id)) !== null) await ctx.db.delete(id);
    return null;
  },
});

/** A pass that failed: the entry stays for the next, and the label says why. */
export const fail = internalMutation({
  args: { id: v.id("linkRepairs"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, error }) => {
    if ((await ctx.db.get(id)) !== null) await ctx.db.patch(id, { error, leaseAt: undefined });
    return null;
  },
});

function codeOf(error: unknown): string {
  const data = error && typeof error === "object" && "data" in error ? (error as { data?: { code?: unknown } }).data : undefined;
  const code = data?.code ?? (error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined);
  return typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "REPAIR_FAILED";
}

/** Work through a workspace's queue, an entry at a time, handing on to another pass when this one has done its share. */
export const repairWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    for (let entries = 0; entries < ENTRIES_PER_PASS; entries += 1) {
      const entry = await ctx.runMutation(internal.functions.linkRepairs.claim, { workspaceId, now: Date.now() });
      if (entry === null) return null;
      try {
        const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
          workspaceId,
          scope: "private",
          operation: { kind: "repairLinks", pairs: entry.pairs },
        })) as { kind: string; notes?: number; links?: number; capped?: boolean };
        if (result.kind !== "linksRepaired" || result.capped === true) {
          await ctx.runMutation(internal.functions.linkRepairs.fail, { id: entry.id, error: "REWRITE_CAPPED" });
          return null;
        }
        await ctx.runMutation(internal.functions.linkRepairs.finish, { id: entry.id });
        // Counts only, never a path.
        console.log(JSON.stringify({ event: "linkRepairs.repaired", workspaceId, files: entry.pairs.length, notes: result.notes ?? 0, links: result.links ?? 0 }));
      } catch (error) {
        await ctx.runMutation(internal.functions.linkRepairs.fail, { id: entry.id, error: codeOf(error) });
        return null;
      }
    }
    await ctx.scheduler.runAfter(0, internal.functions.linkRepairs.repairWorkspace, { workspaceId });
    return null;
  },
});

/** Every workspace with entries waiting and no pass holding them gets one: a pass that stopped is picked up here. */
export const repairDue = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const page = await ctx.db.query("linkRepairs").paginate({ cursor: cursor ?? null, numItems: DUE_PAGE });
    const started = new Set<Id<"workspaces">>();
    for (const entry of page.page) {
      if (started.has(entry.workspaceId) || leased(entry, now)) continue;
      started.add(entry.workspaceId);
      await ctx.scheduler.runAfter(0, internal.functions.linkRepairs.repairWorkspace, { workspaceId: entry.workspaceId });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.functions.linkRepairs.repairDue, { cursor: page.continueCursor });
    return null;
  },
});

/** What waits, as counts and fixed labels: never a workspace or a path. */
export const report = internalQuery({
  args: {},
  returns: v.object({ entries: v.number(), files: v.number(), workspaces: v.number(), failing: v.record(v.string(), v.number()) }),
  handler: async (ctx) => {
    const answer = { entries: 0, files: 0, workspaces: 0, failing: {} as Record<string, number> };
    const workspaces = new Set<string>();
    for await (const entry of ctx.db.query("linkRepairs")) {
      answer.entries += 1;
      answer.files += entry.pairs.length;
      workspaces.add(entry.workspaceId);
      if (entry.error !== undefined) answer.failing[entry.error] = (answer.failing[entry.error] ?? 0) + 1;
    }
    answer.workspaces = workspaces.size;
    return answer;
  },
});
