/**
 * Where one workspace is in managed-storage encryption, and what that means
 * for a store built for it.
 *
 * Decision: `docs/decisions/storage-and-credentials/managed-encryption.md`.
 * The state row only counts while the workspace's binding is its managed
 * bucket: a customer-owned bucket is never encrypted, whatever a stale row
 * says, and the hand-off cutover deletes the row anyway.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { managedBucketName } from "../managedStorage";

export type WorkspaceEncryptionState = Doc<"managedEncryptionWorkspaces">["state"];

/** The gateway's two modes (`apps/mcp/src/store/managedEncryption.js`). */
export type GatewayEncryptionMode = "migrating" | "encrypted";

/**
 * `waiting` is plain: the walk has not started, so nothing is sealed and the
 * key may not exist yet. Everything from the first sealed object on accepts
 * both kinds on read, until the check has passed; a failed walk stays mixed.
 */
export function gatewayModeFor(state: WorkspaceEncryptionState | null): GatewayEncryptionMode | null {
  switch (state) {
    case null:
    case "waiting":
      return null;
    case "encrypting":
    case "checking":
    case "failed":
      return "migrating";
    case "encrypted":
      return "encrypted";
  }
}

/** Derived from the bucket's name, as everywhere else — there is no flag. */
export function bindingIsManaged(
  binding: Pick<Doc<"storageBindings">, "bucket" | "workspaceId"> | null,
): boolean {
  if (binding === null || typeof binding.bucket !== "string") return false;
  try {
    return binding.bucket === managedBucketName(binding.workspaceId);
  } catch {
    return false;
  }
}

export async function workspaceEncryptionRow(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"managedEncryptionWorkspaces"> | null> {
  return await ctx.db
    .query("managedEncryptionWorkspaces")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** The mode a store for this workspace must be built in, or null for plain. */
export async function gatewayModeForWorkspace(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<GatewayEncryptionMode | null> {
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (!bindingIsManaged(binding)) return null;
  const row = await workspaceEncryptionRow(ctx, workspaceId);
  return gatewayModeFor(row?.state ?? null);
}

/**
 * What an owner or member sees in Settings > Storage. `null` hides the row:
 * not managed, or not reached yet (a promise before the rollout reaches them
 * is a promise we might not keep). A failed walk reads as `paused` to them;
 * the reason is staff-side.
 */
export type OwnerEncryptionView = {
  state: "encrypting" | "checking" | "encrypted" | "paused";
  filesDone?: number;
  filesTotal?: number;
};

export function ownerViewFor(
  row: Doc<"managedEncryptionWorkspaces"> | null,
  rolloutState: Doc<"managedEncryptionRollout">["state"] | null,
): OwnerEncryptionView | null {
  if (row === null || row.state === "waiting") return null;
  if (row.state === "encrypted") return { state: "encrypted" };
  const progress = {
    filesDone: row.filesDone,
    ...(row.filesTotal === undefined ? {} : { filesTotal: row.filesTotal }),
  };
  if (row.state === "failed" || rolloutState === "paused" || rolloutState === "failed") {
    return { state: "paused", ...progress };
  }
  return { state: row.state, ...progress };
}
