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
import { linkFillPass, readLinkState } from "../../../../mcp/src/tree/links.js";
import { CHANGE_OVERLAP_MS } from "../../../../mcp/src/tree/changes.js";
import { clearanceOf } from "../clearance";
import { treeChanges } from "./treeChanges";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "../d1";
import { type FileStore, loadPrivacyState, type PrivacyState, type ProjectionClient } from "../fileOps";
import { audiencesForChange, type TreeChange, trimTrailingSlashes } from "../treeAnnounce";
import { treeAudiences } from "../treeAudiences";
import type { FileOperation, OperationResult } from "./operationTypes";

/** Sweep passes one chain may run: a bound on a loop, not on any context. */
export const TREE_SWEEP_CHAIN = 50;

export type TreeOperation = Extract<FileOperation, { kind: "sweepTree" | "touchTree" | "treeState" | "treeChanges" }>;

export function isTreeOperation(operation: { kind: string }): operation is TreeOperation {
  return (
    operation.kind === "sweepTree" ||
    operation.kind === "touchTree" ||
    operation.kind === "treeState" ||
    operation.kind === "treeChanges"
  );
}

/** What a tree operation answers for a context with no table to ask. */
export function noTreeTable(operation: TreeOperation): OperationResult {
  if (operation.kind === "treeState") {
    return { kind: "treeState", status: "unreachable", rows: null, sweptAt: null, dirty: false, error: null };
  }
  if (operation.kind !== "treeChanges") return { kind: "treeKept", complete: false };
  return {
    kind: "treeChanges",
    full: true,
    entries: [],
    folders: [],
    gone: [],
    goneFolders: [],
    since: operation.since,
    after: operation.after ?? "",
    more: false,
    privacy: null,
    manifestUsable: true,
  };
}

/**
 * The table's health, for the staff panel: counts and its own bookkeeping,
 * never a path. Asked before the bucket's credential is, because it needs none.
 */
export async function treeStateOf(client: ProjectionClient): Promise<OperationResult> {
  try {
    const state = await readTreeState(client);
    let rows = 0;
    try {
      const [count] = await client.query("SELECT count(*) AS n FROM tree");
      rows = Number(count?.n ?? 0);
    } catch {
      // No table yet.
    }
    const status = state.unsupported ? "unsupported" : state.cursor !== null ? "filling" : state.ready ? "ready" : "empty";
    return { kind: "treeState", status, rows, sweptAt: state.sweptAt, dirty: state.dirty, error: withoutKeys(state.error) };
  } catch {
    return { kind: "treeState", status: "unreachable", rows: null, sweptAt: null, dirty: false, error: null };
  }
}

/** A staff-safe label; raw storage errors can contain private note paths. */
export function withoutKeys(message: string | null): string | null {
  if (message === null) return null;
  if (message === "the storage listing said there was more but returned nothing new") {
    return "Storage listing returned no new objects";
  }
  return "Tree fill failed; inspect service logs";
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
  args: {
    workspaceId: Id<"workspaces">;
    scope: "private" | "team";
    operation: { kind: string; source?: string; cursor?: string };
  },
  store: FileStore,
): Promise<{ store: FileStore; source: "tree" | "bucket"; since?: number; privacy?: string | null }> {
  if (args.operation.kind === "workspaceGraph") return { store: await withLinkTable(ctx, args, store), source: "bucket" };
  if (args.operation.kind !== "manifest") return { store, source: "bucket" };
  if (args.operation.source !== "tree") {
    // An app that walks the bucket still starts the table filling, so it is
    // ready for the next walk that can read it.
    if (args.operation.cursor === undefined) await startSweepIfDue(ctx, args).catch(() => {});
    return { store, source: "bucket" };
  }
  try {
    const client = await treeClient(ctx, args.workspaceId);
    if (client === null) return { store, source: "bucket" };
    const state = await readTreeState(client);
    if (sweepDue(state, Date.now())) await scheduleSweep(ctx, args.workspaceId, args.scope, 0);
    if (!state.ready || state.unsupported) return { store, source: "bucket" };
    const table = { store: treeListingStore(store, client) as FileStore, source: "tree" as const };
    if (args.operation.cursor !== undefined || state.now === null) return table;
    // A walk's first page says where a catch-up after it starts: the table's
    // clock and the `privacy.md` version, both read before the walk, so
    // anything that lands during it is read again rather than missed.
    const privacy = await loadPrivacyState(store);
    return { ...table, since: state.now - CHANGE_OVERLAP_MS, privacy: privacy.etag };
  } catch {
    // A database that cannot be read is no table: the walk goes to the bucket.
    return { store, source: "bucket" };
  }
}

/**
 * The map's store: the same bucket, carrying the tree's link table where it
 * has parsed every note once (`linkTable`, read by `workspaceGraph`). Where
 * it has not, or notes have changed since, a fill pass is scheduled and the
 * map reads the search index meanwhile, or draws from the table as "behind".
 */
async function withLinkTable(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team" },
  store: FileStore,
): Promise<FileStore> {
  try {
    const client = await treeClient(ctx, args.workspaceId);
    if (client === null) return store;
    const links = await readLinkState(client);
    if (!links.treeReady) {
      await startSweepIfDue(ctx, args);
      return store;
    }
    if (!links.ready || (links.unparsed ?? 0) > 0) await scheduleSweep(ctx, args.workspaceId, args.scope, 0);
    if (!links.ready) return store;
    const linkTable = { client, unparsed: links.unparsed ?? 0 };
    // Non-enumerable, as the meaning index is attached: nothing that walks the store carries it out.
    Object.defineProperty(store, "linkTable", { value: linkTable, enumerable: false, configurable: true });
    return store;
  } catch {
    return store;
  }
}

/** Schedule a sweep for this context's table if one is due. Never for a context with none. */
async function startSweepIfDue(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team" },
): Promise<void> {
  const client = await treeClient(ctx, args.workspaceId);
  if (client === null) return;
  const state = await readTreeState(client);
  if (sweepDue(state, Date.now())) await scheduleSweep(ctx, args.workspaceId, args.scope, 0);
}

/** Run a `sweepTree` or `touchTree` with the bucket the barrier opened. */
export async function runTreeOperation(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team"; grantedNames?: string[]; operation: TreeOperation },
  store: FileStore,
  client: ProjectionClient,
): Promise<OperationResult> {
  const operation = args.operation;
  if (operation.kind === "treeChanges") {
    return await treeChanges(store, client, operation, clearanceOf(args.scope, args.grantedNames ?? []));
  }
  if (operation.kind === "touchTree") {
    try {
      await touchTree(store, client, { paths: operation.paths, files: operation.files, left: operation.left ?? [] });
    } finally {
      await markChanged(ctx, args.workspaceId, operation.audiences);
    }
    // A table never filled, or one a change was too big for, is filled now
    // rather than when somebody next happens to read it. On a whole one, a
    // change to the tree's shape has its links read now; a save of text alone
    // waits for the next reader, since every save would otherwise be a pass.
    const state = await readTreeState(client).catch(() => null);
    const due = state !== null && (!state.ready || state.dirty) && sweepDue(state, Date.now());
    const linksDue = state !== null && state.ready && state.cursor === null && operation.paths.length > 0;
    if (due || linksDue) {
      await scheduleSweep(ctx, args.workspaceId, args.scope, 0);
    }
    return { kind: "treeKept", complete: true };
  }
  if (operation.kind === "treeState") return await treeStateOf(client);
  const passes = Math.floor(operation.passes ?? 0) + 1;
  // A whole tree with no sweep due spends this pass on its links instead: the
  // notes changed since they were last parsed (`tree/links.js`).
  const state = await readTreeState(client).catch(() => null);
  if (state !== null && state.ready && !state.unsupported && state.cursor === null && !sweepDue(state, Date.now())) {
    const links = await linkFillPass(store, client).catch(() => null);
    if (links !== null && links.read > 0 && links.remaining > 0 && passes < TREE_SWEEP_CHAIN) {
      await scheduleSweep(ctx, args.workspaceId, args.scope, passes);
    }
    return { kind: "treeKept", complete: links?.remaining === 0 };
  }
  const pass = await sweepTreePass(store, client).catch(() => null);
  // A finished sweep goes on to the links, through the branch above.
  const more = pass !== null && !pass.unsupported && (pass.complete || pass.rows + pass.pages > 0);
  if (more && passes < TREE_SWEEP_CHAIN) {
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
  change: { paths: string[]; files: string[]; audiences: string[]; left?: { path: string; audiences: string[] }[] },
): Promise<void> {
  const touches = change.paths.length + change.files.length > 0;
  if (touches && (await hasTreeDatabase(ctx, args.workspaceId))) {
    const scheduled = await ctx.scheduler
      .runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope: args.scope,
        operation: {
          kind: "touchTree",
          paths: change.paths,
          files: change.files,
          audiences: change.audiences,
          ...(change.left === undefined || change.left.length === 0 ? {} : { left: change.left }),
        },
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
    // Who could see each key this took away, by the manifest from before it:
    // what a device catching up is told by (`treeChanges.ts`). Unknown
    // without that manifest, and then only the owner is told.
    const left = before === null
      ? []
      : [...gone].map((path) => ({ path, audiences: treeAudiences([path], before.rules, before.overrides) }));
    await keepTreeAndAnnounce(ctx, args, { paths: [...paths, ...gone], files, audiences, left });
  } catch {
    // See above: a hint is never a failed change.
  }
}
