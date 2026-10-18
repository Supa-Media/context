/**
 * Access asked for on a path that has no row yet, in rows mode (`setAccess`,
 * `ensureFolderDefault`). A note saved private is written to the bucket after
 * its privacy is decided, so its row does not exist when the tier is asked for;
 * this keeps the ask until the row is born, and then gives the row that access
 * in the same mutation (`convexNodeTable.insert`).
 *
 * Fail closed while it waits: a private pending entry is rendered as a private
 * override (or folder rule) by `accessRowsOf`, so the path is closed to members
 * before its row exists. A team pending entry is not rendered: the path inherits,
 * which is the narrower answer where the folder is private.
 *
 * An entry is dropped unapplied after `PENDING_TTL_MS`. A note whose row is born
 * after that inherits, as a note with no row always has.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { SNAPSHOT_MAX_ROWS } from "./accessBackfill";
import type { AccessRow } from "./rowAccess";

/** How long a pending access waits for its row before it is dropped. */
export const PENDING_TTL_MS = 60 * 60 * 1000;

/** The most pending entries one workspace holds; past it a new one is refused (`PENDING_FULL`). */
export const PENDING_MAX = 100;

export type PendingEntry = NonNullable<Doc<"nodeAccessState">["pending"]>[number];

/** The entries still waiting at `now`. */
export function livePending(entries: readonly PendingEntry[] | undefined, now: number): PendingEntry[] {
  return (entries ?? []).filter((entry) => entry.at >= now - PENDING_TTL_MS);
}

/**
 * The rows a reader judges by, with the private pending entries that have no row among them added as rows that
 * carry only their base. Team pending entries are left out (see the header).
 */
export function withPendingPrivate(rows: AccessRow[], pending: readonly PendingEntry[] | undefined, now: number): AccessRow[] {
  const held = new Set(rows.map((row) => row.path));
  const extra: AccessRow[] = [];
  for (const entry of livePending(pending, now)) {
    if (entry.base !== "private" || held.has(entry.path)) continue;
    extra.push({ path: entry.path, noteId: "", kind: entry.kind, base: "private", grantees: [] });
  }
  return extra.length === 0 ? rows : [...rows, ...extra];
}

/**
 * Gives a row inserted at a path the access that was asked for it before it existed, and drops that entry.
 * Called by `convexNodeTable.insert` for every new row, in the mutation that inserts it. An entry of the other
 * kind is left for the row of its kind; an expired one is dropped unapplied.
 *
 * Applied to the snapshot too (when there is one): the snapshot is what readers read, and a row missing from it
 * would be judged by its folder. The version does not move: no rule the gateway holds has changed, only a row
 * born where the rules already said.
 */
export async function applyPendingAccess(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  row: { id: Id<"nodes">; path: string; kind: "file" | "folder"; noteId: string },
  now: number,
): Promise<void> {
  const state = await ctx.db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const entry = state?.pending?.find((pending) => pending.path === row.path);
  if (state === null || entry === undefined || entry.kind !== row.kind) return;
  const remaining = (state.pending ?? []).filter((pending) => pending.path !== row.path);
  if (entry.at < now - PENDING_TTL_MS) {
    await ctx.db.patch(state._id, { pending: remaining });
    return;
  }
  await ctx.db.patch(row.id, { access: { base: entry.base } });
  let snapshot = state.snapshot;
  if (snapshot !== undefined) {
    const next = [...snapshot, { path: row.path, noteId: row.noteId, kind: row.kind, base: entry.base, grantees: [] }];
    snapshot = next.length > SNAPSHOT_MAX_ROWS ? undefined : next;
  }
  await ctx.db.patch(state._id, { pending: remaining, snapshot });
}
