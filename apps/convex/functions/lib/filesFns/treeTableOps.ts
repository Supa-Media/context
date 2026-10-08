/**
 * The tree table, from the console's side: reading a context's tree from it,
 * sweeping it, and re-checking what a console change touched.
 *
 * What the table is and why it can be trusted is `apps/mcp/src/tree/table.js`.
 * This file is the control plane's three uses of it, each run inside the
 * credential barrier (`runFileOperation`) because each needs the bucket:
 *
 *  - **A manifest asked for with `source: "tree"`** — the browser tab's
 *    sidebar walk — is served from the table once a sweep has finished, by
 *    handing the unchanged `syncManifest` a store whose `list` reads the table
 *    (`treeListingStore`). Every privacy decision is still `canSee` over the
 *    live `privacy.md`. A table that is not ready, or that a sweep is due on,
 *    schedules one and the walk falls back to the bucket.
 *  - **`sweepTree`** lists the bucket into the table a bounded piece at a
 *    time, and chains itself until it finishes.
 *  - **`touchTree`** re-checks the paths a console change named, and only then
 *    tells the open trees to look again, so a tab told the tree changed reads
 *    the change rather than the row before it.
 *
 * The table lives in the context's fast-search database, so it exists exactly
 * where that database does (`projectionTargetForWorkspace`). Where there is
 * none, every caller here behaves as it did before the table existed.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
// The gateway's D1 wire, imported rather than ported: `apps/mcp` targets the
// Workers runtime, which is Convex's runtime too. It holds the write token for
// the life of one call and puts it in exactly one place, an `Authorization`
// header.
import { createD1Client } from "../../../../mcp/src/search/d1/client.js";
import { readTreeState } from "../../../../mcp/src/tree/table.js";
import { sweepDue, sweepTreePass } from "../../../../mcp/src/tree/sweep.js";
import { touchTree } from "../../../../mcp/src/tree/touch.js";
import { treeListingStore } from "../../../../mcp/src/tree/source.js";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "../d1";
import { type FileStore, loadPrivacyState, type PrivacyState, type ProjectionClient } from "../fileOps";
import { audiencesForChange, type TreeChange, trimTrailingSlashes } from "../treeAnnounce";
import type { FileOperation, OperationResult } from "./operationTypes";

/** Sweep passes one chain may run: a bound on a loop, not on any context. */
export const TREE_SWEEP_CHAIN = 50;

export type TreeOperation = Extract<FileOperation, { kind: "sweepTree" | "touchTree" }>;

export function isTreeOperation(operation: { kind: string }): operation is TreeOperation {
  return operation.kind === "sweepTree" || operation.kind === "touchTree";
}

/**
 * A client for this context's search database, given a target the caller has
 * already accepted. `null` for a deployment with no Cloudflare credential.
 * Ours, not a customer's: `appSecrets` holds this deployment's own
 * integration credentials.
 */
export async function searchDatabaseClient(
  ctx: ActionCtx,
  target: { databaseId: string; state: string },
): Promise<ProjectionClient | null> {
  const apiToken = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: D1_TOKEN_SECRET,
  });
  const accountId = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: D1_ACCOUNT_SECRET,
  });
  if (
    typeof apiToken !== "string" ||
    apiToken.length === 0 ||
    typeof accountId !== "string" ||
    accountId.length === 0
  ) {
    return null;
  }
  // No `fetchImpl`: the client resolves `globalThis.fetch` per call and
  // carries its own deadline.
  return createD1Client({
    databaseId: target.databaseId,
    accountId,
    apiToken,
    state: target.state,
  }) as ProjectionClient;
}

/** Whether this context has a database the table can live in. A query, no secret read. */
export async function hasTreeDatabase(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const target = await ctx
    .runQuery(internal.functions.fastSearch.projectionTargetForWorkspace, { workspaceId })
    .catch(() => null);
  return target !== null;
}

/** The table's client, or `null` where the context has no database or we have no credential. */
export async function treeClient(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<ProjectionClient | null> {
  const target = await ctx
    .runQuery(internal.functions.fastSearch.projectionTargetForWorkspace, { workspaceId })
    .catch(() => null);
  if (target === null) return null;
  return await searchDatabaseClient(ctx, target).catch(() => null);
}

async function scheduleSweep(ctx: ActionCtx, workspaceId: Id<"workspaces">, scope: "private" | "team", passes: number) {
  await ctx.scheduler
    .runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId,
      scope,
      operation: { kind: "sweepTree", passes },
    })
    .catch(() => {});
}

/**
 * The store a `source: "tree"` manifest walks: the table where it can answer,
 * the bucket otherwise. Schedules a sweep when one is due, either way.
 */
export async function manifestSource(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team"; operation: { kind: string; source?: string } },
  store: FileStore,
): Promise<{ store: FileStore; source: "tree" | "bucket" }> {
  if (args.operation.kind !== "manifest" || args.operation.source !== "tree") {
    return { store, source: "bucket" };
  }
  try {
    const client = await treeClient(ctx, args.workspaceId);
    if (client === null) return { store, source: "bucket" };
    const state = await readTreeState(client);
    if (sweepDue(state, Date.now())) await scheduleSweep(ctx, args.workspaceId, args.scope, 0);
    if (!state.ready || state.unsupported) return { store, source: "bucket" };
    return { store: treeListingStore(store, client) as FileStore, source: "tree" };
  } catch {
    // A database that cannot be read is no table: the walk goes to the bucket.
    return { store, source: "bucket" };
  }
}

/** Run a `sweepTree` or `touchTree` with the bucket the barrier opened. */
export async function runTreeOperation(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team"; operation: TreeOperation },
  store: FileStore,
  client: ProjectionClient,
): Promise<OperationResult> {
  const operation = args.operation;
  if (operation.kind === "touchTree") {
    try {
      await touchTree(store, client, { paths: operation.paths, files: operation.files });
    } finally {
      await markChanged(ctx, args.workspaceId, operation.audiences);
    }
    return { kind: "treeKept", complete: true };
  }
  const pass = await sweepTreePass(store, client).catch(() => null);
  const passes = Math.floor(operation.passes ?? 0) + 1;
  if (pass !== null && !pass.complete && !pass.unsupported && pass.rows + pass.pages > 0 && passes < TREE_SWEEP_CHAIN) {
    await scheduleSweep(ctx, args.workspaceId, args.scope, passes);
  }
  return { kind: "treeKept", complete: pass?.complete === true };
}

/**
 * Before the bucket is opened: a tree operation for a context with no
 * database does nothing, except that a re-check still delivers the tree hint
 * it was carrying. `null` means the operation is not a tree one.
 */
export async function treeOperationClient(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; operation: { kind: string } },
): Promise<{ client: ProjectionClient | null } | null> {
  if (!isTreeOperation(args.operation)) return null;
  const client = await treeClient(ctx, args.workspaceId);
  if (client === null && args.operation.kind === "touchTree") {
    await markChanged(ctx, args.workspaceId, args.operation.audiences);
  }
  return { client };
}

async function markChanged(ctx: ActionCtx, workspaceId: Id<"workspaces">, audiences: string[]) {
  if (audiences.length === 0) return;
  await ctx
    .runMutation(internal.functions.treeSignals.markTreeChanged, { workspaceId, audiences })
    .catch(() => {});
}

/**
 * After a console change: re-check what it touched, then tell its audiences.
 * With no database the audiences are told at once, as before the table.
 */
export async function keepTreeAndAnnounce(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team" },
  change: { paths: string[]; files: string[]; audiences: string[] },
): Promise<void> {
  const touches = change.paths.length + change.files.length > 0;
  if (touches && (await hasTreeDatabase(ctx, args.workspaceId))) {
    const scheduled = await ctx.scheduler
      .runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope: args.scope,
        operation: { kind: "touchTree", paths: change.paths, files: change.files, audiences: change.audiences },
      })
      .then(() => true)
      .catch(() => false);
    if (scheduled) return;
  }
  await markChanged(ctx, args.workspaceId, change.audiences);
}

/**
 * Tell the audiences that can see this change that their tree is stale.
 *
 * After the operation and never inside it, like the activity stamp: the
 * change is in the customer's bucket by now, a hint is a derivative of it,
 * and a failure to send one must never look like a failed save — so every
 * step is inside the catch, and a lost hint is caught by the client's
 * periodic walk. An operation that threw never reaches here, so a failed
 * change is never announced.
 *
 * Who is told is `audiencesForChange`, beside `treeAudiences`. Where the
 * context has a tree table, the paths are re-checked in it first and the
 * audiences told after (`keepTreeAndAnnounce`); `files` are notes whose text
 * alone changed, re-checked without telling anybody.
 */
export async function announceTreeChange(
  ctx: ActionCtx,
  store: FileStore,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team" },
  change: TreeChange | null,
  result: OperationResult,
  before: PrivacyState | null,
  files: string[] = [],
): Promise<void> {
  if (change === null) {
    if (files.length > 0) await keepTreeAndAnnounce(ctx, args, { paths: [], files, audiences: [] });
    return;
  }
  try {
    const paths = [...change.paths];
    const gone = new Set((change.gone ?? []).map(trimTrailingSlashes));
    // Where a note actually landed — an archive's dated folder, a duplicate's
    // new name — is only in the answer. Its source is gone from where it was.
    if (result.kind === "moved") {
      const moved = result as { from?: unknown; to?: unknown };
      if (typeof moved.from === "string") {
        paths.push(moved.from);
        gone.add(trimTrailingSlashes(moved.from));
      }
      if (typeof moved.to === "string") paths.push(moved.to);
    }
    const after = await loadPrivacyState(store);
    const audiences = audiencesForChange({ change, paths, gone, before, after });
    await keepTreeAndAnnounce(ctx, args, { paths: [...paths, ...gone], files, audiences });
  } catch {
    // See above: a hint is never a failed change.
  }
}
