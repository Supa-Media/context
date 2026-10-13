/**
 * The tree table, from the console's side: reading a context's tree from it,
 * sweeping it, and re-checking what a console change touched.
 *
 * What the table is and why it can be trusted is `apps/mcp/src/tree/table.js`.
 * This file is the control plane's three uses of it, each run inside the
 * credential barrier (`runFileOperation`) because each needs the bucket:
 *
 *  - **A manifest asked for with `source: "tree"`** — the browser tab's
 *    sidebar walk — is served from the Convex tree where it serves, else the
 *    bucket. The table no longer answers a walk (phase 7 of
 *    `docs/decisions/app-and-console/convex-tree.md`); a walk only schedules
 *    its sweep, because the props and link fills read their notes from it.
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
import { createD1Client, D1Error, failureDetailOf } from "../../../../mcp/src/search/d1/client.js";
import { readTreeState, setStateStatements } from "../../../../mcp/src/tree/table.js";
import { sweepDue, sweepTreePass } from "../../../../mcp/src/tree/sweep.js";
import { touchTree } from "../../../../mcp/src/tree/touch.js";
import { linkFillPass, readLinkState } from "../../../../mcp/src/tree/links.js";
import { propFillPass } from "../../../../mcp/src/tree/props.js";
import { folderNotesFromNodes, folderNotesFromTable, tablePropSource } from "./folderNotes";
import { chaosAfterFill, chaosScoreOf, liveChaosScoreOf, NO_CHAOS, rescoreTouched, tableChaosSource } from "./chaosOps";
import { factChaosSource, factPropSource, factsReady } from "../nodes/factSources";
import { clearanceOf } from "../clearance";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "../d1";
import { type FileStore, loadPrivacyState, type PrivacyState, type ProjectionClient } from "../fileOps";
import { audiencesForChange, type TreeChange, trimTrailingSlashes } from "../treeAnnounce";
import { treeAudiences } from "../treeAudiences";
import { PRIVACY_KEY } from "../privacy";
import { isServedStore, servedNodesStore } from "../nodes/manifestStore";
import { attachLinkTable, convexLinkTable, d1LinkTable } from "../nodes/linkTable";
import { scheduleFactFill } from "../nodes/factFill";
import { scheduleNodesTouch, startNodesSweepIfDue, touchNodesNow } from "../nodes/run";
import type { FileOperation, OperationResult } from "./operationTypes";

/** Sweep passes one chain may run: a bound on a loop, not on any context. */
export const TREE_SWEEP_CHAIN = 50;

export type TreeOperation = Extract<
  FileOperation,
  { kind: "sweepTree" | "touchTree" | "treeState" | "folderNotes" | "chaosScore" }
>;

export function isTreeOperation(operation: { kind: string }): operation is TreeOperation {
  return (
    operation.kind === "sweepTree" ||
    operation.kind === "touchTree" ||
    operation.kind === "treeState" ||
    operation.kind === "folderNotes" ||
    operation.kind === "chaosScore"
  );
}

/** A tree operation the Convex tree's facts can answer for a context with no search database. */
export function answersWithoutTable(operation: { kind: string }): boolean {
  return operation.kind === "folderNotes" || operation.kind === "chaosScore";
}

/** What a tree operation answers for a context with no table to ask. */
export function noTreeTable(operation: TreeOperation): OperationResult {
  if (operation.kind === "treeState") {
    return { kind: "treeState", status: "unreachable", rows: null, sweptAt: null, dirty: false, error: null };
  }
  if (operation.kind === "folderNotes") {
    return { kind: "folderNotes", available: false, notes: [], cursor: null, missing: [], fill: false };
  }
  if (operation.kind === "chaosScore") return NO_CHAOS;
  return { kind: "treeKept", complete: false };
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

async function scheduleSweep(ctx: ActionCtx, workspaceId: Id<"workspaces">, scope: "private" | "team", passes: number, delay = 0) {
  await ctx.scheduler
    .runAfter(delay, internal.functions.files.runFileOperation, {
      workspaceId,
      scope,
      operation: { kind: "sweepTree", passes },
    })
    .catch(() => {});
}

/** Operations that only read which notes exist, answered from the rows where the tree serves. */
const SERVED_READS = new Set(["workspaceGraph", "notePaths", "folderPaths"]);

/** Organizer actions that only read: `gather` (the sweep's work list) and `outline`. */
const ORGANIZER_READS = new Set(["gather", "outline"]);

/**
 * The store a `source: "tree"` manifest walks: the Convex tree where it serves
 * the workspace (`servedNodesStore`), else the table where it can answer, else
 * the bucket. Schedules a sweep when one is due. A walk the Convex tree answers
 * says `nodes`, and its first page carries where a catch-up from the tree's
 * change log starts.
 */
export async function manifestSource(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    scope: "private" | "team";
    operation: { kind: string; source?: string; cursor?: string; action?: unknown };
  },
  store: FileStore,
): Promise<{ store: FileStore; source: "tree" | "bucket" | "nodes"; since?: number; privacy?: string | null }> {
  // The organizer's read-only passes list every note: from the tree where it
  // serves (phase 5). Its writes keep the bucket's listing and rules.
  if (args.operation.kind === "organizer" && typeof args.operation.action === "string" && ORGANIZER_READS.has(args.operation.action)) {
    const served = await servedNodesStore(ctx, args.workspaceId, store).catch(() => null);
    return served === null ? { store, source: "bucket" } : { store: served, source: "nodes" };
  }
  // The Convex tree's shadow starts filling on the first page of any walk (`lib/nodes/run.ts`).
  if (args.operation.kind === "manifest" && args.operation.cursor === undefined) {
    await startNodesSweepIfDue(ctx, args.workspaceId);
  }
  // Read-only readers of which notes exist: the map, link completion and the
  // folder picker read the rows where the tree serves (`servedNodesStore`),
  // and the bucket or the search index where it does not.
  if (SERVED_READS.has(args.operation.kind)) {
    const served = await servedNodesStore(ctx, args.workspaceId, store).catch(() => null);
    const chosen = served ?? store;
    const reading = args.operation.kind === "workspaceGraph" ? await withLinkTable(ctx, args, chosen) : chosen;
    return { store: reading, source: served === null ? "bucket" : "nodes" };
  }
  if (args.operation.kind !== "manifest") return { store, source: "bucket" };
  if (args.operation.source !== "tree") {
    // An app that walks the bucket still starts the table filling, so it is
    // ready for the next walk that can read it.
    if (args.operation.cursor === undefined) await startSweepIfDue(ctx, args).catch(() => {});
    return { store, source: "bucket" };
  }
  // The Convex tree, where it serves: the rows the live listings read. The
  // first page says where a catch-up from the tree's change log starts
  // (`nodesFeed.ts`), read before the rows: a move or a rules change landing
  // in between leaves the copy judged by the older version, which walks again,
  // rather than claiming a version the rows were not read under.
  const start = args.operation.cursor === undefined
    ? await ctx
      .runQuery(internal.functions.nodesFeed.walkStart, { workspaceId: args.workspaceId, now: Date.now() })
      .catch(() => null)
    : null;
  const served = await servedNodesStore(ctx, args.workspaceId, store).catch(() => null);
  if (served !== null) {
    if (args.operation.cursor !== undefined) return { store: served, source: "nodes" };
    return { store: served, source: "nodes", ...(start === null ? {} : start) };
  }
  // Elsewhere the bucket (phase 7: the D1 table no longer answers a walk). Its
  // sweep still runs, because the props and link fills read their notes from it.
  if (args.operation.cursor === undefined) await startSweepIfDue(ctx, args).catch(() => {});
  return { store, source: "bucket" };
}

/**
 * The map's store: the same bucket, carrying a link table where one has
 * parsed every note once (`lib/nodes/linkTable.ts`). Where the Convex tree
 * serves, its facts (`lib/nodes/facts.ts`); until they have read every note,
 * and wherever the tree does not serve, the search database's. Where neither
 * has, or notes have changed since, a fill is started and the map reads the
 * search index meanwhile, or draws from the table as "behind".
 */
async function withLinkTable(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team" },
  store: FileStore,
): Promise<FileStore> {
  if (isServedStore(store)) {
    const table = await convexLinkTable(ctx, args.workspaceId, store).catch(() => null);
    if (table === null || table.unparsed > 0) await scheduleFactFill(ctx, args.workspaceId);
    if (table !== null) return attachLinkTable(store, table);
  }
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
    return attachLinkTable(store, d1LinkTable(client, links.unparsed ?? 0));
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

/** `index_state` key: when a List last asked for a properties fill. */
const PROP_FILL_ASKED = "tree_props_fill_asked";

/**
 * A fill pass for a properties table a List found behind, unless a sweep is
 * already running (it goes on to the links and properties when it finishes).
 */
async function startFillIfIdle(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team" },
  client: ProjectionClient,
): Promise<void> {
  const state = await readTreeState(client);
  if (state.cursor !== null) return;
  // A List redraws on every tree change; one chain a minute is plenty.
  const [asked] = await client.query("SELECT value FROM index_state WHERE key = ?1", [PROP_FILL_ASKED]);
  if (state.now !== null && Number(asked?.value) > state.now - 60_000) return;
  await client.runAll(setStateStatements({ [PROP_FILL_ASKED]: state.now ?? Date.now() }));
  await scheduleSweep(ctx, args.workspaceId, args.scope, 0);
}

/**
 * Run a tree operation with the bucket the barrier opened. `client` is the
 * search database, `null` where the context has none: a List and the chaos
 * score can still answer from the Convex tree's facts, and nothing else runs.
 */
export async function runTreeOperation(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team"; grantedNames?: string[]; operation: TreeOperation },
  store: FileStore,
  client: ProjectionClient | null,
): Promise<OperationResult> {
  const operation = args.operation;
  if (operation.kind === "folderNotes") {
    // Which notes are in the folder: the Convex tree where it serves, at the
    // names it draws while a move is pending, else the search database.
    // Their front matter: the rows' own once the facts have read every note,
    // else the search database's, either looked up where each note still
    // sits (`folderNotesFromNodes`). The D1 table never answers for a served
    // tree: its rows are at bucket keys, judged by the old names' rules.
    const clearance = clearanceOf(args.scope, args.grantedNames ?? []);
    const served = await servedNodesStore(ctx, args.workspaceId, store).catch(() => null);
    if (served !== null && (await factsReady(ctx, args.workspaceId))) {
      const answer = await folderNotesFromNodes(served, factPropSource(ctx, args.workspaceId), operation, clearance);
      if (answer.available) return answer;
    }
    if (client === null) return noTreeTable(operation);
    const answer =
      served !== null
        ? await folderNotesFromNodes(served, tablePropSource(client), operation, clearance)
        : await folderNotesFromTable(store, client, operation, clearance);
    if (answer.fill) await startFillIfIdle(ctx, args, client).catch(() => {});
    return answer;
  }
  if (operation.kind === "chaosScore") {
    // Counted from the Convex tree's keys where it serves, with its facts once
    // they have read every note, else the search database's; else the
    // database's own numbers.
    const clearance = clearanceOf(args.scope, args.grantedNames ?? []);
    const served = await servedNodesStore(ctx, args.workspaceId, store).catch(() => null);
    const sources = [
      ...(served !== null ? [factChaosSource(ctx, args.workspaceId, client)] : []),
      ...(served !== null && client !== null ? [tableChaosSource(client)] : []),
    ];
    for (const source of sources) {
      const live = await liveChaosScoreOf(served!, source, operation, clearance).catch(() => null);
      if (live !== null) return live;
    }
    return client === null ? NO_CHAOS : await chaosScoreOf(store, client, operation, clearance);
  }
  if (client === null) return noTreeTable(operation);
  if (operation.kind === "touchTree") {
    try {
      await touchTree(store, client, { paths: operation.paths, files: operation.files });
      // The chaos score moves with the change, before the open trees are told.
      await rescoreTouched(store, client, { paths: operation.paths, files: operation.files });
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
  // notes changed since they were last parsed (`tree/links.js`); and once
  // those are done, on its properties (`tree/props.js`), the same way.
  const state = await readTreeState(client).catch(() => null);
  if (state !== null && state.ready && !state.unsupported && state.cursor === null && !sweepDue(state, Date.now())) {
    const links = await linkFillPass(store, client).catch(() => null);
    const props = links?.remaining === 0 ? await propFillPass(store, client).catch(() => null) : null;
    // Lengths come from the properties fill, so the chaos score follows it.
    await chaosAfterFill(store, client, props);
    const more =
      (links !== null && links.read > 0 && links.remaining > 0) || (props !== null && props.read > 0 && props.remaining > 0);
    if (more && passes < TREE_SWEEP_CHAIN) {
      await scheduleSweep(ctx, args.workspaceId, args.scope, passes);
    }
    return { kind: "treeKept", complete: links?.remaining === 0 && props?.remaining === 0 };
  }
  let retryD1 = false;
  const pass = await sweepTreePass(
    {
      list: async (options: Parameters<FileStore["list"]>[0]) => {
        try {
          return await store.list(options);
        } catch (error) {
          // Storage errors may contain bucket names or note paths. The stage
          // and workspace id are enough to distinguish this from a D1 fault.
          console.error("tree_index.list_failed", { workspaceId: args.workspaceId });
          throw error;
        }
      },
    },
    client,
  ).catch((error) => {
    const detail = failureDetailOf(error);
    retryD1 = error instanceof D1Error && (error.code === "RATE_LIMITED" || error.code === "UNAVAILABLE");
    console.error("tree_index.sweep_failed", {
      workspaceId: args.workspaceId,
      source: detail === null ? "storage_or_internal" : "d1",
      detail,
    });
    return null;
  });
  if (retryD1 && passes < TREE_SWEEP_CHAIN) {
    await scheduleSweep(ctx, args.workspaceId, args.scope, passes, 30_000);
  }
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
  store?: FileStore,
): Promise<void> {
  const touches = change.paths.length + change.files.length > 0;
  // The Convex tree is re-checked whether or not this context has a search
  // database: before the change answers when the bucket is open here, since
  // the console reads that tree (phase 2), and scheduled otherwise.
  const nodesChange = { paths: change.paths, files: change.files };
  if (touches && store !== undefined) await touchNodesNow(ctx, args.workspaceId, store, nodesChange);
  else if (touches) await scheduleNodesTouch(ctx, args.workspaceId, nodesChange);
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
    if (files.length > 0) await keepTreeAndAnnounce(ctx, args, { paths: [], files, audiences: [] }, store);
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
    // A change that rewrote the rules re-reads them into the tree's mirror too.
    const rules = before === null || before.etag !== after.etag ? [PRIVACY_KEY] : [];
    await keepTreeAndAnnounce(ctx, args, { paths: [...paths, ...gone], files: [...files, ...rules], audiences, left }, store);
  } catch {
    // See above: a hint is never a failed change.
  }
}
