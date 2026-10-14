/**
 * Where a workspace's small data stands (`smallDataState`,
 * `lib/schema/smallData.ts`): whether its bucket files have been imported,
 * the version of its icons and of its forwarding ledger, and whether the
 * files are owed a write from them.
 *
 * Every change to the rows goes through `markChanged`, which asks for one
 * sync (`lib/smallData/sync.ts`): the import first, where it has not run,
 * then the files written from the rows. One sync is scheduled or running at
 * a time (`syncAt`); a change made while one runs is picked up by that one,
 * which goes round again when the versions moved under it.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";

/** How long a scheduled or running sync holds the workspace before another may start. */
export const SMALL_DATA_SYNC_LEASE_MS = 5 * 60_000;

export type SmallDataState = Doc<"smallDataState">;

export async function smallDataStateOf(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<SmallDataState | null> {
  return await db
    .query("smallDataState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** The state row, created when the workspace has none yet. */
export async function ensureSmallDataState(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<SmallDataState> {
  const found = await smallDataStateOf(ctx.db, workspaceId);
  if (found !== null) return found;
  const id = await ctx.db.insert("smallDataState", {
    workspaceId,
    forwardingVersion: 0,
    forwardingExported: 0,
    iconsVersion: 0,
    iconsExported: 0,
  });
  return (await ctx.db.get(id))!;
}

/** Whether the workspace's bucket files have been read in. */
export async function smallDataImported(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<boolean> {
  return (await smallDataStateOf(db, workspaceId))?.importedAt !== undefined;
}

/** Whether either file is behind its rows. */
export function exportOwed(state: SmallDataState | null): boolean {
  return state !== null && (state.forwardingExported < state.forwardingVersion || state.iconsExported < state.iconsVersion);
}

/** Whether a sync wants to run: never imported, or a file owed a write. */
export function syncWanted(state: SmallDataState | null): boolean {
  return state === null || state.importedAt === undefined || exportOwed(state);
}

function leased(state: SmallDataState | null, now: number): boolean {
  return state?.syncAt !== undefined && now - state.syncAt < SMALL_DATA_SYNC_LEASE_MS;
}

/**
 * Schedule one sync when one is wanted and none holds the workspace. A
 * workspace with no bucket bound has nothing to import from or write to, and
 * is left alone. Returns whether one was scheduled.
 */
export async function requestSmallDataSync(ctx: MutationCtx, workspaceId: Id<"workspaces">, now = Date.now()): Promise<boolean> {
  const state = await smallDataStateOf(ctx.db, workspaceId);
  if (!syncWanted(state) || leased(state, now)) return false;
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .first();
  if (binding === null) return false;
  const row = state ?? (await ensureSmallDataState(ctx, workspaceId));
  await ctx.db.patch(row._id, { syncAt: now });
  await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "nodesSmallData" },
  });
  return true;
}

/** The rows changed: move the version, which owes the file a write, and ask for the sync that writes it. */
export async function markChanged(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  which: "forwarding" | "icons",
): Promise<void> {
  const state = await ensureSmallDataState(ctx, workspaceId);
  await ctx.db.patch(state._id, {
    ...(which === "forwarding" ? { forwardingVersion: state.forwardingVersion + 1 } : { iconsVersion: state.iconsVersion + 1 }),
  });
  await requestSmallDataSync(ctx, workspaceId);
}
