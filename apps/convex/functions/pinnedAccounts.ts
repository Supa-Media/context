/**
 * The pinned workspace's move to "team means members" (decided by the owner, 2026-10-19;
 * `docs/decisions/privacy-and-sharing/all-context-users.md`). It runs on its own after a deploy: the cron that keeps
 * every tree current (`nodesMigration.keepCurrent`, every fifteen minutes) calls `startIfDue`, which starts it once
 * rows mode is on and the pinned workspace exists, and does nothing once it has finished. Nobody runs it by hand.
 *
 * Until it has run, pin readers read `@context-lc` at `team`, as they always did (`lib/pinnedReaders.ts`). It walks
 * the pinned workspace's rows in two passes, each page its own transaction, each page scheduling the next:
 *
 *  1. **Every `team` row gets the `accounts` view grant**, so a note every account could read stays readable by
 *     every account, now as All Context users. Except anything under the Areas folder's `tex-bugs/`: bug reports
 *     carry people's own texts and end up members only. The last page of this pass sets
 *     `nodeMigration.pinnedAccountsAt` in the same transaction as its writes, which is the moment pin readers start
 *     reading as guests: every row that was `team` already carries its grant, so nothing they read goes dark, and
 *     no row that was members only was ever open to them.
 *  2. **Every row in the old Members position** (base `private` plus the built-in `members` grant, notes and folders
 *     alike) becomes base `team` with that grant removed: the same people, and now also every MCP connection of a
 *     member, which holds no granted names and so never held the members grant's token. Only after the switch,
 *     because before it `team` was still every account's. Its last page sets `pinnedAccountsDoneAt`.
 *
 * Every page stamps `pinnedAccountsPageAt`, so the cron starts no second pass beside one in flight; a chain that
 * stopped (a dropped scheduled function) goes quiet and is started again from the pass the switch says is next.
 *
 * Idempotent: a row that already has its grant, or is no longer in the old position, is passed over, so a rerun,
 * or a run that was interrupted and started again, changes nothing that is done. A deployment with no pinned
 * workspace only sets the switch.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { bugFolder } from "./lib/feedback/bugNote";
import { refreshSnapshot } from "./lib/nodes/accessBackfill";
import { folderJobsOf } from "./lib/nodes/folderJobs";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { rowsAfter } from "./lib/nodes/paths";

/** A pass whose last page ran this recently is in flight: the cron leaves it alone. Two cron periods. */
export const PINNED_ACCOUNTS_IN_FLIGHT_MS = 30 * 60 * 1000;

/** Rows one page reads. Each can write a grant or a patch and a delete or two, well inside one transaction. */
export const PINNED_ACCOUNTS_PAGE = 200;

const phaseValidator = v.union(v.literal("accounts"), v.literal("members"));
type Phase = "accounts" | "members";

/** Start, or start again: the pass the switch says is next, from the first row. */
export const start = internalMutation({
  args: { pageSize: v.optional(v.number()) },
  returns: v.string(),
  handler: async (ctx, { pageSize }): Promise<string> => await startPass(ctx, pageSize),
});

async function startPass(ctx: MutationCtx, pageSize?: number): Promise<string> {
  const row = await switchRow(ctx);
  const phase: Phase = row?.pinnedAccountsAt === undefined ? "accounts" : "members";
  // Stamped now, not when the page runs: a second tick before then must see this pass in flight.
  if (row !== null) await ctx.db.patch(row._id, { pinnedAccountsPageAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.functions.pinnedAccounts.page, { phase, after: null, pageSize });
  return `started: ${phase}`;
}

/**
 * The cron's hook (`nodesMigration.keepCurrent`): start a pass when one is owed. One `nodeMigration` read when there
 * is nothing to do, which is every tick after the move has finished. Owed means rows mode, not finished, no pass in
 * flight, and a pinned workspace to move: a deployment with none is left exactly as it is.
 */
export async function startIfDue(ctx: MutationCtx, now = Date.now()): Promise<boolean> {
  const row = await switchRow(ctx);
  if (row === null || row.pinnedAccountsDoneAt !== undefined) return false;
  if (row.pinnedAccountsPageAt !== undefined && now - row.pinnedAccountsPageAt < PINNED_ACCOUNTS_IN_FLIGHT_MS) return false;
  if ((await pinnedContextWorkspace(ctx)) === null) return false;
  await startPass(ctx);
  return true;
}

/** The same hook as its own function, for tests and for a staff tool that wants to nudge it. */
export const startIfDueNow = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx): Promise<boolean> => await startIfDue(ctx),
});

/** One page of one pass, scheduling the next; the last page of the first pass flips the switch. */
export const page = internalMutation({
  args: { phase: phaseValidator, after: v.union(v.null(), v.string()), pageSize: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { phase, after, pageSize }): Promise<null> => {
    // The first pass after the switch would grant every account the rows the second pass has made members-only.
    if (phase === "accounts" && (await switchRow(ctx))?.pinnedAccountsAt !== undefined) return null;
    const pinned = await pinnedContextWorkspace(ctx);
    if (pinned === null) {
      if (phase === "accounts") await flipSwitch(ctx);
      return null;
    }
    const size = Math.max(1, Math.min(pageSize ?? PINNED_ACCOUNTS_PAGE, PINNED_ACCOUNTS_PAGE));
    const rows = await rowsAfter(ctx.db, pinned._id, "", after ?? undefined, size);
    await stamp(ctx, { pinnedAccountsPageAt: Date.now() });
    const bugs = await bugRootOf(ctx, pinned._id);
    let changed = false;
    for (const row of rows) {
      changed = (phase === "accounts" ? await grantAccounts(ctx, row, bugs) : await membersToTeam(ctx, row)) || changed;
    }
    if (changed) await refreshSnapshot(ctx, pinned._id);
    if (rows.length === size) {
      await ctx.scheduler.runAfter(0, internal.functions.pinnedAccounts.page, {
        phase,
        after: rows[rows.length - 1].path,
        pageSize,
      });
      return null;
    }
    if (phase === "accounts") {
      await flipSwitch(ctx);
      await ctx.scheduler.runAfter(0, internal.functions.pinnedAccounts.page, { phase: "members", after: null, pageSize });
    } else {
      await stamp(ctx, { pinnedAccountsDoneAt: Date.now() });
    }
    return null;
  },
});

/** Where the bug reports live (`lib/feedback/bugNote.ts`): `<Areas>/tex-bugs`, for the folder doing the Areas job. */
async function bugRootOf(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<string[]> {
  const areas = (await folderJobsOf(ctx.db, workspaceId)).jobs.areas ?? null;
  const root = (team: string) => team.slice(0, team.lastIndexOf("/"));
  // Both the folder doing the job now and the default name, in case a report was filed before the job moved.
  return [...new Set([root(bugFolder(areas, true)), root(bugFolder(null, true))])];
}

function under(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

async function ownGrants(ctx: MutationCtx, row: Doc<"nodes">): Promise<Doc<"nodeAccess">[]> {
  return (
    await ctx.db
      .query("nodeAccess")
      .withIndex("by_node", (q) => q.eq("nodeId", row._id))
      .collect()
  ).filter((grant) => grant.source !== "share");
}

/** Pass 1: a `team` row outside the bug reports gets the `accounts` view grant, once. */
async function grantAccounts(ctx: MutationCtx, row: Doc<"nodes">, bugs: readonly string[]): Promise<boolean> {
  if (row.goneAt !== undefined || row.access?.base !== "team" || under(row.path, bugs)) return false;
  if ((await ownGrants(ctx, row)).some((grant) => grant.granteeKind === "accounts")) return false;
  await ctx.db.insert("nodeAccess", {
    workspaceId: row.workspaceId,
    nodeId: row._id,
    granteeKind: "accounts",
    role: "view",
    at: Date.now(),
    source: "owner",
  });
  return true;
}

/** Pass 2: the old Members position (base `private` plus the `members` grant) becomes base `team`, grant removed. */
async function membersToTeam(ctx: MutationCtx, row: Doc<"nodes">): Promise<boolean> {
  if (row.goneAt !== undefined || row.access?.base !== "private") return false;
  const members = (await ownGrants(ctx, row)).filter((grant) => grant.granteeKind === "members");
  if (members.length === 0) return false;
  await ctx.db.patch(row._id, { access: { base: "team" } });
  for (const grant of members) await ctx.db.delete(grant._id);
  return true;
}

async function switchRow(ctx: MutationCtx): Promise<Doc<"nodeMigration"> | null> {
  return await ctx.db.query("nodeMigration").first();
}

async function stamp(ctx: MutationCtx, fields: Partial<Pick<Doc<"nodeMigration">, "pinnedAccountsPageAt" | "pinnedAccountsDoneAt">>) {
  const row = await switchRow(ctx);
  if (row !== null) await ctx.db.patch(row._id, fields);
}

/** From now on a pin reader reads as a guest (`lib/pinnedReaders.ts`). Set once; a rerun keeps the first time. */
async function flipSwitch(ctx: MutationCtx): Promise<void> {
  const row = await switchRow(ctx);
  if (row === null || row.pinnedAccountsAt !== undefined) return;
  await ctx.db.patch(row._id, { pinnedAccountsAt: Date.now() });
}
