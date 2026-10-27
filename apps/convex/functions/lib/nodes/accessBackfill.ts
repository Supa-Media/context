/**
 * The tree's access rows: the handle resolver, and the snapshot readers scan
 * instead of the rows (`nodeAccessState.snapshot`).
 *
 * The rows are the only source of access. An owner's write (`setAccess`,
 * `consoleAccess`, a grant) lands on a row, and `refreshSnapshot` rebuilds
 * the snapshot from the rows as they are. Nothing is derived from a
 * `privacy.md` any more (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { resolveAddressedUser } from "../identities";
import { scanAccessRows } from "./accessRows";
import type { AccessRow } from "./rowAccess";

/** A grant a handle resolved to: a person of this deployment, or a group of this workspace. */
export type Grant = { kind: "user"; userId: Id<"users"> } | { kind: "group"; groupId: Id<"workspaceGroups"> };

/** Handles resolved within one page, so a name that many rows name is looked up once. */
export type Cache = Map<string, Grant | null>;

/** The most rows the snapshot holds. Past this (or `SNAPSHOT_MAX_BYTES`, which a document also has to fit under) the snapshot is not stored and readers scan the rows. */
export const SNAPSHOT_MAX_ROWS = 4_000;

/** The most bytes of JSON the snapshot may be; a Convex document is capped well above this. */
export const SNAPSHOT_MAX_BYTES = 800_000;

/**
 * The fact behind an `@name`, in this workspace, or `null`.
 *
 * A group is looked up first: group names are unique across the `names`
 * table, so a group of another workspace is found here and resolves to
 * nothing, rather than falling through to a person of the same name. A
 * person resolves the way every addressed share does (`resolveAddressedUser`).
 */
export async function resolveHandle(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  visibility: string,
  cache: Cache,
): Promise<Grant | null> {
  const cached = cache.get(visibility);
  if (cached !== undefined) return cached;
  const name = visibility.slice(1);
  const group = await ctx.db
    .query("workspaceGroups")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  let grant: Grant | null;
  if (group !== null) {
    grant = group.workspaceId === workspaceId ? { kind: "group", groupId: group._id } : null;
  } else {
    const userId = await resolveAddressedUser(ctx, { kind: "name", value: name });
    grant = userId === null ? null : { kind: "user", userId };
  }
  cache.set(visibility, grant);
  return grant;
}

/**
 * The snapshot of the rows as they are: every row that carries a setting or a grant. `undefined` when it is
 * too large to store, and readers scan the rows instead.
 */
export async function snapshotOf(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<AccessRow[] | undefined> {
  const rows = await scanAccessRows(ctx, workspaceId);
  const bytes = JSON.stringify(rows).length;
  if (rows.length > SNAPSHOT_MAX_ROWS || bytes > SNAPSHOT_MAX_BYTES) {
    console.log(JSON.stringify({ event: "access.snapshot_too_large", workspaceId, count: rows.length }));
    return undefined;
  }
  return rows;
}

/** Rebuild the snapshot from the rows as they are, and bump the version: the one refresh after any change to the rows. */
export async function refreshSnapshot(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<number> {
  const state = await ctx.db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const snapshot = await snapshotOf(ctx, workspaceId);
  const version = (state?.version ?? 0) + 1;
  if (state === null) await ctx.db.insert("nodeAccessState", { workspaceId, version, orphans: [], snapshot });
  else await ctx.db.patch(state._id, { version, snapshot });
  return version;
}
