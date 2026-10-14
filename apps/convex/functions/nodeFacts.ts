/**
 * Notes' facts in Convex (`lib/nodes/facts.ts`): the fill's steps, and the
 * reads the map, a move's link rewrite and Lists make. Every one is internal;
 * the bucket reads happen in the fill pass (`lib/nodes/factFill.ts`), which
 * runs inside the credential barrier.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type DatabaseReader } from "../_generated/server";
import { routinePathsOf, scheduleReconcile } from "./lib/routines/sync";
import {
  FACT_FILL_NOTES,
  FACT_LEASE_MS,
  FACT_LOG_OVERLAP,
  FACT_LOG_PAGE,
  LINK_PAGE_ROWS,
  FACT_RETRY_CAP,
  MOVE_RENAMES_CAP,
  MOVE_UNPARSED_CAP,
  PROPS_AT_PATHS,
  type FactState,
  dropLinks,
  factsCurrent,
  freshWalk,
  hasLinks,
  isFactNote,
  factStateRow,
  liveNode,
  logHead,
  logReaches,
  writeFacts,
} from "./lib/nodes/facts";

/** Rows of the tree one walk step looks through. */
const WALK_ROWS = 2_000;

const stateValidator = v.object({
  ready: v.boolean(),
  seq: v.number(),
  after: v.optional(v.string()),
  startSeq: v.optional(v.number()),
  retry: v.optional(v.array(v.string())),
});

const dueValidator = v.object({
  path: v.string(),
  etag: v.optional(v.string()),
  gone: v.optional(v.boolean()),
});

function stateOf(row: { ready: boolean; seq: number; after?: string; startSeq?: number; retry?: string[] }): FactState {
  return {
    ready: row.ready,
    seq: row.seq,
    ...(row.after === undefined ? {} : { after: row.after }),
    ...(row.startSeq === undefined ? {} : { startSeq: row.startSeq }),
    ...(row.retry === undefined || row.retry.length === 0 ? {} : { retry: row.retry }),
  };
}

/**
 * Take the fill for one pass, or `null` while another holds it. Starts a walk
 * for a workspace with none, and again for one the log no longer reaches.
 */
export const claim = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.union(v.null(), stateValidator),
  handler: async (ctx, { workspaceId, now }) => {
    const row = await factStateRow(ctx.db, workspaceId);
    if (row === null) {
      const fresh = freshWalk(await logHead(ctx.db, workspaceId, now));
      await ctx.db.insert("nodeFactState", { workspaceId, ...fresh, leaseAt: now });
      return fresh;
    }
    if (row.leaseAt !== undefined && now - row.leaseAt < FACT_LEASE_MS) return null;
    if (row.ready && !logReaches(stateOf(row), now)) {
      const fresh = freshWalk(await logHead(ctx.db, workspaceId, now));
      await ctx.db.patch(row._id, { ...fresh, after: undefined, retry: undefined, retryKind: undefined, retryPasses: undefined, leaseAt: now });
      return fresh;
    }
    await ctx.db.patch(row._id, { leaseAt: now });
    return stateOf(row);
  },
});

/** The note a walk or a log row names, as the pass should treat it, or `null` when it is current. */
async function dueNote(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string) {
  const node = await liveNode(db, workspaceId, path);
  if (node === null) return (await hasLinks(db, workspaceId, path)) ? { path, gone: true } : null;
  if (factsCurrent(node)) return null;
  return { path, ...(node.etag === undefined ? {} : { etag: node.etag }) };
}

/**
 * What one pass should read, and where the fill stands once it has. A walk
 * goes on from `after`; a caught-up fill reads the log after `seq`, a minute
 * back for late commits, plus the notes that failed last time.
 */
export const due = internalQuery({
  args: { workspaceId: v.id("workspaces"), state: stateValidator },
  returns: v.object({ notes: v.array(dueValidator), next: stateValidator, more: v.boolean() }),
  handler: async (ctx, { workspaceId, state }) => {
    const notes: Array<{ path: string; etag?: string; gone?: boolean }> = [];
    const seen = new Set<string>();
    const consider = async (path: string) => {
      if (seen.has(path) || !isFactNote(path)) return;
      seen.add(path);
      const note = await dueNote(ctx.db, workspaceId, path);
      if (note !== null) notes.push(note);
    };

    if (!state.ready) {
      const rows = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) =>
          state.after === undefined ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("path", state.after),
        )
        .take(WALK_ROWS);
      let last: string | undefined;
      for (const row of rows) {
        last = row.path;
        if (row.kind === "file" && row.goneAt === undefined) await consider(row.path);
        if (notes.length >= FACT_FILL_NOTES) break;
      }
      const finished = rows.length < WALK_ROWS && last === rows[rows.length - 1]?.path;
      const next: FactState = finished
        ? { ready: true, seq: state.startSeq ?? state.seq }
        : { ready: false, seq: state.seq, ...(last === undefined ? {} : { after: last }), ...(state.startSeq === undefined ? {} : { startSeq: state.startSeq }) };
      // A finished walk goes on to the log it noted the head of.
      return { notes, next, more: true };
    }

    for (const path of state.retry ?? []) await consider(path);
    let from = state.seq - FACT_LOG_OVERLAP;
    let rows = await ctx.db
      .query("nodeLog")
      .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId).gt("seq", from))
      .take(FACT_LOG_PAGE);
    // A minute of log fuller than a page would be read again for ever: go on from `seq` itself.
    if (rows.length === FACT_LOG_PAGE && rows[rows.length - 1]!.seq <= state.seq) {
      from = state.seq;
      rows = await ctx.db
        .query("nodeLog")
        .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId).gt("seq", from))
        .take(FACT_LOG_PAGE);
    }
    let seq = state.seq;
    let stopped = false;
    for (const row of rows) {
      if (notes.length >= FACT_FILL_NOTES) {
        stopped = true;
        break;
      }
      await consider(row.path);
      seq = Math.max(seq, row.seq);
    }
    return { notes, next: { ready: true, seq }, more: stopped || rows.length === FACT_LOG_PAGE };
  },
});

const parsedValidator = v.object({
  path: v.string(),
  etag: v.optional(v.string()),
  gone: v.optional(v.boolean()),
  links: v.array(v.array(v.string())),
  /** `propsOf` as JSON, or null for an encrypted note. */
  props: v.union(v.string(), v.null()),
});

/**
 * Record what one pass read. A note whose row has moved on to another version
 * since it was read is left for the log row that change wrote.
 */
export const record = internalMutation({
  args: { workspaceId: v.id("workspaces"), notes: v.array(parsedValidator) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, notes }) => {
    for (const note of notes) {
      const node = await liveNode(ctx.db, workspaceId, note.path);
      // Gone from the tree, or from the bucket under a row a sweep has yet to remove.
      if (note.gone === true || node === null) {
        await dropLinks(ctx.db, workspaceId, note.path);
        continue;
      }
      if (note.etag !== undefined && node.etag !== note.etag) continue;
      const links = note.links.filter((row): row is [string, string] => row.length === 2);
      await writeFacts(ctx.db, node, { links, props: note.props });
    }
    // A routine's schedule is read from these props, so a routine waiting on them is scanned again.
    if (routinePathsOf(notes.map((note) => note.path)) !== null) await scheduleReconcile(ctx, workspaceId, []);
    return null;
  },
});

/** Where the fill stands after a pass, and the notes to try again. Releases the pass's hold. */
export const finish = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    next: stateValidator,
    failed: v.array(v.string()),
    /** Why most of `failed` did not read, when this pass read them. */
    failedKind: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { workspaceId, next, failed, failedKind }) => {
    const row = await factStateRow(ctx.db, workspaceId);
    // Forgotten with its workspace or its bucket while the pass ran.
    if (row === null) return null;
    const retry = [...new Set(failed)].slice(0, FACT_RETRY_CAP);
    // A pass that died keeps the last pass's words and count: it read nothing.
    const why =
      retry.length === 0
        ? { retryKind: undefined, retryPasses: undefined }
        : failedKind === undefined
          ? {}
          : { retryKind: failedKind, retryPasses: (row.retryPasses ?? 0) + 1 };
    await ctx.db.patch(row._id, {
      ...why,
      ready: next.ready,
      seq: next.seq,
      after: next.after,
      startSeq: next.startSeq,
      retry: retry.length === 0 ? undefined : retry,
      leaseAt: undefined,
    });
    return null;
  },
});

/** Notes changed since their links were read, up to `cap + 1`: the log past `seq`, and the failed reads. */
async function unparsedNotes(db: DatabaseReader, workspaceId: Id<"workspaces">, state: FactState, cap: number) {
  const found = new Set<string>();
  for (const path of state.retry ?? []) found.add(path);
  const rows = await db
    .query("nodeLog")
    .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId).gt("seq", state.seq - FACT_LOG_OVERLAP))
    .take(FACT_LOG_PAGE);
  for (const row of rows) {
    if (found.size > cap) break;
    if (!isFactNote(row.path) || found.has(row.path)) continue;
    if ((await dueNote(db, workspaceId, row.path)) !== null) found.add(row.path);
  }
  // A log past one page is more change than a move should trust the rows for.
  if (rows.length === FACT_LOG_PAGE) return null;
  return [...found];
}

/** Whether the rows can be read, and how many notes they are behind. */
export const readiness = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ ready: v.boolean(), unparsed: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    const row = await factStateRow(ctx.db, workspaceId);
    if (row === null || !row.ready) return { ready: false, unparsed: 0 };
    const unparsed = await unparsedNotes(ctx.db, workspaceId, stateOf(row), FACT_LOG_PAGE);
    return { ready: true, unparsed: unparsed === null ? FACT_LOG_PAGE : unparsed.length };
  },
});

/** One page of every link, in source order, as `[source, kind, target]`. */
export const page = internalQuery({
  args: { workspaceId: v.id("workspaces"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ rows: v.array(v.array(v.string())), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { workspaceId, cursor }) => {
    const result = await ctx.db
      .query("nodeLinks")
      .withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId))
      .paginate({ cursor, numItems: LINK_PAGE_ROWS });
    return {
      rows: result.page.map((row) => [row.source, row.kind, row.target]),
      cursor: result.continueCursor,
      done: result.isDone,
    };
  },
});

/**
 * The notes whose links can name what a move renamed: every note pointing at
 * one of `sources` by path or at one of `names` bare, and every note changed
 * since it was read. `null` where the rows cannot be trusted for it, and the
 * rewrite reads every note as before.
 */
export const candidates = internalQuery({
  args: { workspaceId: v.id("workspaces"), sources: v.array(v.string()), names: v.array(v.string()) },
  returns: v.union(v.null(), v.object({ pointing: v.array(v.string()), unparsed: v.array(v.string()) })),
  handler: async (ctx, { workspaceId, sources, names }) => {
    const row = await factStateRow(ctx.db, workspaceId);
    if (row === null || !row.ready) return null;
    if (sources.length + names.length > MOVE_RENAMES_CAP) return null;
    const unparsed = await unparsedNotes(ctx.db, workspaceId, stateOf(row), MOVE_UNPARSED_CAP);
    if (unparsed === null || unparsed.length > MOVE_UNPARSED_CAP) return null;
    const pointing = new Set<string>();
    const lookups: Array<[string, "path" | "name"]> = [
      ...[...new Set(sources)].map((target): [string, "path"] => [target, "path"]),
      ...[...new Set(names)].map((target): [string, "name"] => [target, "name"]),
    ];
    for (const [target, kind] of lookups) {
      const rows = await ctx.db
        .query("nodeLinks")
        .withIndex("by_workspace_target", (q) => q.eq("workspaceId", workspaceId).eq("target", target).eq("kind", kind))
        .collect();
      for (const link of rows) pointing.add(link.source);
    }
    return { pointing: [...pointing], unparsed };
  },
});

/** Whether the facts are behind the tree: a walk unfinished, or log rows past `seq`. */
export const behind = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }) => {
    const row = await factStateRow(ctx.db, workspaceId);
    if (row === null || !row.ready) return true;
    const next = await ctx.db
      .query("nodeLog")
      .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId).gt("seq", row.seq))
      .first();
    return next !== null;
  },
});

/**
 * The props of exactly these notes, for a List whose notes the served rows
 * named (`folderNotesFromNodes`): each with the version it was read at.
 * Unfiltered, like the rows the caller already put through `canSee`; a note
 * never read, or read too large to keep, is absent and read from the bucket.
 */
export const propsAt = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.array(
    v.object({ path: v.string(), version: v.union(v.string(), v.null()), sealed: v.boolean(), props: v.union(v.string(), v.null()) }),
  ),
  handler: async (ctx, { workspaceId, paths }) => {
    if (paths.length > PROPS_AT_PATHS) throw new Error("nodes.props_at_too_many");
    const found = [];
    for (const path of new Set(paths)) {
      const row = await liveNode(ctx.db, workspaceId, path);
      if (row === null || row.parsed === undefined) continue;
      found.push({
        path,
        version: row.parsed === "" ? null : row.parsed,
        sealed: row.sealed === true,
        props: row.props ?? null,
      });
    }
    return found;
  },
});

/**
 * These notes' props as their rows hold them now, for the routine scan: each
 * `current` (read at its version), `waiting` (changed since, or never read),
 * or absent when the tree has no such note.
 */
export const propsNow = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.array(
    v.object({ path: v.string(), current: v.boolean(), sealed: v.boolean(), props: v.union(v.string(), v.null()) }),
  ),
  handler: async (ctx, { workspaceId, paths }) => {
    if (paths.length > PROPS_AT_PATHS) throw new Error("nodes.props_at_too_many");
    const found = [];
    for (const path of new Set(paths)) {
      const row = await liveNode(ctx.db, workspaceId, path);
      if (row === null) continue;
      found.push({ path, current: factsCurrent(row), sealed: row.sealed === true, props: row.props ?? null });
    }
    return found;
  },
});

/** Whether the facts have read every note once: one row, for a reader choosing its source. */
export const ready = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }) => (await factStateRow(ctx.db, workspaceId))?.ready === true,
});
