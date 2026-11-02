/**
 * Access changes, carried from Convex to the objects while a workspace is on `dual` (`lib/accessHandOff/`; decided by
 * the owner, 2026-11-01: `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * Every mutation that changes members, invites, groups, connections or shares by name, for an object whose switch is
 * not `convex`, leaves an outbox entry naming the object and its changed tables, and schedules `drain`. One drain at
 * a time holds an object (a lease), so its copies leave in the order they were read. Each round reads those tables
 * whole as Convex holds them now (`accessObjects.ts` `expectedFor`) and writes them whole into the object under one
 * epoch, the read time (`writeTable`): the object keeps a table only from a newer epoch, so a late round never rolls
 * a newer one back. An entry leaves the outbox only after the object took it.
 *
 * A push that fails leaves its entries; the lease is let go and the drain is tried again (`RETRY_MS`), and the
 * minute sweep picks up any object whose entries wait longer than that. While Convex decides (`dual`), a late push
 * lets nobody in: the object's copy is not read for a decision until the switch, which needs a clean parity check.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type ActionCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import type { AccessDoor } from "./lib/accessObjects/door";
import type { AccessTable } from "./lib/accessObjects/expected";
import { objectTableValidator } from "./lib/schema/accessObjectOutbox";
import { accessHomeOf, type AccessScope } from "./lib/accessObjects/home";
import { scopeOf } from "./lib/accessHandOff/flush";
import { AUTHORITY_TABLES } from "./lib/accessHandOff/record";

const homeValidator = v.union(v.literal("convex"), v.literal("dual"), v.literal("object"));
import { doorFor, expectedFor, writeTable } from "./accessObjects";
import { failureOf } from "./lib/workspaceObjects/failures";

/** Outbox entries one round takes. */
const ENTRIES_PER_ROUND = 50;
/** Rounds one drain runs before handing on to a fresh one. */
const ROUNDS_PER_DRAIN = 20;
/** How long a drain holds an object; longer than any one round. */
export const LEASE_MS = 2 * 60 * 1000;
/** How soon a failed push is tried again. */
export const RETRY_MS = 30 * 1000;
/** Objects one sweep restarts. */
const SWEEP_LIMIT = 100;

/** Take the object for one drain, or `false` while another holds it. */
export const claim = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, now }) => {
    const held = await ctx.db
      .query("accessObjectPushLeases")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (held !== null && held.until > now) return false;
    if (held === null) await ctx.db.insert("accessObjectPushLeases", { workspaceId, until: now + LEASE_MS });
    else await ctx.db.patch(held._id, { until: now + LEASE_MS });
    return true;
  },
});

/** Let the object go, after a failure. */
export const release = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const held = await ctx.db
      .query("accessObjectPushLeases")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (held !== null) await ctx.db.delete(held._id);
    return null;
  },
});

/** The entries the object took, gone; `true` while more wait (the lease is kept), else the lease goes too. */
export const ack = internalMutation({
  args: { workspaceId: v.id("workspaces"), entryIds: v.array(v.id("accessObjectOutbox")), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, entryIds, now }) => {
    for (const id of entryIds) {
      const entry = await ctx.db.get(id);
      if (entry !== null && entry.workspaceId === workspaceId) await ctx.db.delete(id);
    }
    const next = await ctx.db
      .query("accessObjectOutbox")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
      .first();
    const held = await ctx.db
      .query("accessObjectPushLeases")
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

/** The oldest waiting entries for one object, and its switch. */
export const pending = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    entries: v.array(v.object({ id: v.id("accessObjectOutbox"), tables: v.array(objectTableValidator) })),
    homes: v.object({ workspace: homeValidator, person: homeValidator }),
  }),
  handler: async (ctx, { workspaceId }) => {
    const entries = await ctx.db
      .query("accessObjectOutbox")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
      .take(ENTRIES_PER_ROUND);
    return {
      entries: entries.map((entry) => ({ id: entry._id, tables: entry.tables })),
      homes: { workspace: await accessHomeOf(ctx.db, workspaceId, "workspace"), person: await accessHomeOf(ctx.db, workspaceId, "person") },
    };
  },
});

/** Objects with an entry older than `before`: a drain that failed and was not tried again. */
export const stale = internalQuery({
  args: { before: v.number() },
  returns: v.array(v.id("workspaces")),
  handler: async (ctx, { before }) => {
    const found = new Set<Id<"workspaces">>();
    for await (const entry of ctx.db.query("accessObjectOutbox")) {
      if (entry.at >= before) continue;
      found.add(entry.workspaceId);
      if (found.size >= SWEEP_LIMIT) break;
    }
    return [...found];
  },
});

export type PushDoor = (workspaceId: Id<"workspaces">, scope: AccessScope) => AccessDoor | null;

const defaultDoor: (ctx: ActionCtx) => PushDoor = (ctx) => (workspaceId, scope) => {
  const door = doorFor(ctx, workspaceId, scope);
  return typeof door === "string" ? null : door;
};

/**
 * One drain over `workspaceId`'s entries: each round sends the tables they name, whole, then acknowledges them.
 * `"done"` when the outbox is empty, `"more"` when a fresh drain should carry on, `"busy"` when another holds it,
 * `"failed"` when the object could not take a round (the entries stay).
 */
export async function drainOnce(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  openDoor: PushDoor = defaultDoor(ctx),
): Promise<"done" | "more" | "busy" | "failed"> {
  if (!(await ctx.runMutation(internal.functions.accessObjectPush.claim, { workspaceId, now: Date.now() }))) return "busy";
  try {
    for (let round = 0; round < ROUNDS_PER_DRAIN; round += 1) {
      const { entries, homes } = await ctx.runQuery(internal.functions.accessObjectPush.pending, { workspaceId });
      if (entries.length === 0) {
        await ctx.runMutation(internal.functions.accessObjectPush.release, { workspaceId });
        return "done";
      }
      // A table whose switch went back to `convex` holds no copy to keep current; the copy rewrites it whole if armed again.
      // At `object` the object is the authority for its own tables: only copies are ever sent there.
      const sendable = (table: AccessTable) => {
        const home = homes[scopeOf(table)];
        return home === "dual" || (home === "object" && !AUTHORITY_TABLES.has(table));
      };
      const tables = ([...new Set(entries.flatMap((entry) => entry.tables))].sort() as AccessTable[]).filter(sendable);
      for (const scope of ["workspace", "person"] as const) {
        const sending = tables.filter((table) => scopeOf(table) === scope);
        if (sending.length === 0) continue;
        let personId: Id<"users"> | null = null;
        if (scope === "person") {
          const facts = await ctx.runQuery(internal.functions.accessObjectsRows.workspaceFacts, { workspaceId });
          personId = facts?.personId ?? null;
          // Not a personal workspace (or gone): it holds no person tables, and nothing waits on them.
          if (personId === null) continue;
        }
        const epoch = Date.now();
        const expected = await expectedFor(ctx, workspaceId, scope, personId, epoch);
        const door = openDoor(workspaceId, scope);
        if (door === null) throw new Error("access push: the object cannot take access tables yet");
        for (const table of sending) await writeTable(door, table, expected.tables[table] ?? [], epoch);
      }
      const more = await ctx.runMutation(internal.functions.accessObjectPush.ack, {
        workspaceId,
        entryIds: entries.map((entry) => entry.id),
        now: Date.now(),
      });
      if (!more) return "done";
    }
    return "more";
  } catch (error) {
    console.warn(JSON.stringify({ event: "access_push_failed", ...failureOf(error) }));
    await ctx.runMutation(internal.functions.accessObjectPush.release, { workspaceId });
    return "failed";
  }
}

export const drain = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const outcome = await drainOnce(ctx, workspaceId);
    if (outcome === "more") await ctx.scheduler.runAfter(0, internal.functions.accessObjectPush.drain, { workspaceId });
    if (outcome === "failed") await ctx.scheduler.runAfter(RETRY_MS, internal.functions.accessObjectPush.drain, { workspaceId });
    return null;
  },
});

/** Every minute: restart the drain of any object whose entries have waited past a retry. */
export const sweep = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const waiting = await ctx.runQuery(internal.functions.accessObjectPush.stale, { before: Date.now() - 2 * RETRY_MS });
    for (const workspaceId of waiting) await ctx.scheduler.runAfter(0, internal.functions.accessObjectPush.drain, { workspaceId });
    return null;
  },
});
