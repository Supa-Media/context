/**
 * Notes' facts in Convex (`lib/nodes/facts.ts`): the fill's steps, and the
 * reads the map, a move's link rewrite and Lists make. Every one is internal;
 * the bucket reads happen in the fill pass (`lib/nodes/factFill.ts`), which
 * runs inside the credential barrier.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery, type DatabaseReader } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { routinePathsOf, scheduleReconcile } from "./lib/routines/sync";
import { treeServesNow } from "./lib/nodes/listing";
import { readerMirror } from "./lib/nodes/readerRules";
import { mirrorRules } from "./lib/nodes/log";
import { canSee } from "./lib/privacy";
import { PUBLICATION_SCOPE } from "./lib/websites/publication";
import { namesWebsite, realSitePath, siteRoot } from "./lib/websites/siteRoot";
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
  PROPS_VERSION,
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
  propsPredate,
  writeFacts,
} from "./lib/nodes/facts";
import { rowsAfter } from "./lib/nodes/paths";
import { bareNameOf } from "./lib/nodes/neighbors";

/** Rows of the tree one walk step looks through. */
const WALK_ROWS = 2_000;

const stateValidator = v.object({
  ready: v.boolean(),
  seq: v.number(),
  after: v.optional(v.string()),
  startSeq: v.optional(v.number()),
  retry: v.optional(v.array(v.string())),
  upgrade: v.optional(v.string()),
  upgraded: v.optional(v.boolean()),
});

const dueValidator = v.object({
  path: v.string(),
  etag: v.optional(v.string()),
  gone: v.optional(v.boolean()),
});

function stateOf(row: {
  ready: boolean;
  seq: number;
  after?: string;
  startSeq?: number;
  retry?: string[];
  propsVersion?: number;
  upgradeAfter?: string;
}): FactState {
  return {
    ready: row.ready,
    seq: row.seq,
    ...(row.after === undefined ? {} : { after: row.after }),
    ...(row.startSeq === undefined ? {} : { startSeq: row.startSeq }),
    ...(row.retry === undefined || row.retry.length === 0 ? {} : { retry: row.retry }),
    // A ready fill whose rows predate the props version re-reads them, a page at a time.
    ...(row.ready && row.propsVersion !== PROPS_VERSION ? { upgrade: row.upgradeAfter ?? "" } : {}),
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
      await ctx.db.insert("nodeFactState", { workspaceId, ...fresh, leaseAt: now, propsVersion: PROPS_VERSION });
      return fresh;
    }
    if (row.leaseAt !== undefined && now - row.leaseAt < FACT_LEASE_MS) return null;
    if (row.ready && !logReaches(stateOf(row), now)) {
      const fresh = freshWalk(await logHead(ctx.db, workspaceId, now));
      await ctx.db.patch(row._id, {
        ...fresh,
        after: undefined,
        retry: undefined,
        retryKind: undefined,
        retryPasses: undefined,
        leaseAt: now,
        // A walk reads every note whose props predate the version too.
        propsVersion: PROPS_VERSION,
        upgradeAfter: undefined,
      });
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
  if (factsCurrent(node) && !propsPredate(node)) return null;
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
      const rows = await rowsAfter(ctx.db, workspaceId, "", state.after, WALK_ROWS);
      let last: string | undefined;
      for (const row of rows) {
        last = row.path;
        if (row.kind === "file" && row.goneAt === undefined) await consider(row.path);
        if (notes.length >= FACT_FILL_NOTES) break;
      }
      const finished = rows.length < WALK_ROWS && last === rows[rows.length - 1]?.path;
      const next: FactState = finished
        ? { ready: true, seq: state.startSeq ?? state.seq }
        : {
            ready: false,
            seq: state.seq,
            ...(last === undefined ? {} : { after: last }),
            ...(state.startSeq === undefined ? {} : { startSeq: state.startSeq }),
          };
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
    const next: FactState = { ready: true, seq };
    let upgrading = false;
    if (state.upgrade !== undefined && !stopped) {
      const from = state.upgrade;
      const page = await rowsAfter(ctx.db, workspaceId, "", from === "" ? undefined : from, WALK_ROWS);
      let last: string | undefined;
      for (const row of page) {
        if (notes.length >= FACT_FILL_NOTES) break;
        last = row.path;
        if (row.kind === "file" && row.goneAt === undefined && propsPredate(row)) await consider(row.path);
      }
      if (page.length < WALK_ROWS && last === page[page.length - 1]?.path) next.upgraded = true;
      else {
        next.upgrade = last ?? from;
        upgrading = true;
      }
    } else if (state.upgrade !== undefined) {
      next.upgrade = state.upgrade;
      upgrading = true;
    }
    return { notes, next, more: stopped || rows.length === FACT_LOG_PAGE || upgrading };
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
      ...(next.upgraded === true
        ? { propsVersion: PROPS_VERSION, upgradeAfter: undefined }
        : next.upgrade === undefined
          ? {}
          : { upgradeAfter: next.upgrade }),
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

const linkValidator = v.object({ kind: v.union(v.literal("path"), v.literal("name")), target: v.string() });

/**
 * One note's link rows, for `related_notes` (`lib/nodes/neighbors.ts` resolves
 * them): what it links to, and the notes linking to its path or its bare name.
 * Unfiltered, like `candidates`; the caller judges every path. Each side
 * reads at most `NEIGHBOR_READ_ROWS`, and a side past it answers like any
 * other: a cap the answer reported, or a read that failed at a query limit,
 * would tell a reader how many notes they may not see link here. `null` until
 * the facts have read every note once.
 */
// lean: a hub past this many links on one side loses the rest silently; paging in the action, filtered as it goes, is the upgrade.
export const NEIGHBOR_READ_ROWS = 4_000;

export const neighbors = internalQuery({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      present: v.boolean(),
      current: v.boolean(),
      links: v.array(linkValidator),
      byPath: v.array(v.string()),
      byName: v.array(v.string()),
    }),
  ),
  handler: async (ctx, { workspaceId, path }) => {
    const state = await factStateRow(ctx.db, workspaceId);
    if (state === null || !state.ready) return null;
    const outgoing = await ctx.db
      .query("nodeLinks")
      .withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId).eq("source", path))
      .take(NEIGHBOR_READ_ROWS);
    const pointing = (target: string, kind: "path" | "name") =>
      ctx.db
        .query("nodeLinks")
        .withIndex("by_workspace_target", (q) => q.eq("workspaceId", workspaceId).eq("target", target).eq("kind", kind))
        .take(NEIGHBOR_READ_ROWS);
    const byPath = await pointing(path, "path");
    const byName = await pointing(bareNameOf(path), "name");
    const row = await liveNode(ctx.db, workspaceId, path);
    return {
      present: row !== null,
      current: row !== null && factsCurrent(row),
      links: outgoing.map(({ kind, target }) => ({ kind, target })),
      byPath: byPath.map((link) => link.source),
      byName: byName.map((link) => link.source),
    };
  },
});

/** Whether the facts are behind the tree: a walk unfinished, or log rows past `seq`. */
export const behind = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }) => {
    const row = await factStateRow(ctx.db, workspaceId);
    if (row === null || !row.ready || row.propsVersion !== PROPS_VERSION) return true;
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
  returns: v.array(v.object({ path: v.string(), current: v.boolean(), sealed: v.boolean(), props: v.union(v.string(), v.null()) })),
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

/**
 * The site names its pages under `website/` wherever the folder is nested: each
 * such path is judged and found where the folder is now (`lib/websites/siteRoot.ts`),
 * and answered under the name asked. One tree read, only when a path names it.
 */
async function sitePaths(db: DatabaseReader, workspaceId: Id<"workspaces">, paths: readonly string[]): Promise<(path: string) => string> {
  if (!paths.some(namesWebsite)) return (path) => path;
  const root = await siteRoot(db, workspaceId);
  return (path) => realSitePath(root, path);
}

/**
 * What a public website list shows of these notes, from the tree alone (Dev2,
 * 2026-10-14: names and front matter go through the tree; only a note's
 * content comes from storage). Each note the publication clearance may see —
 * `team` scope, no granted names, the rules mirror's `canSee` — answers with
 * its version, when it last changed, and its props if they were read at that
 * version and carry the website flags (`current`). A note the clearance cannot
 * see is absent, exactly as a read at that clearance would have been. `null`
 * while the tree does not serve.
 */
export const publishedRows = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.union(
    v.null(),
    v.array(
      v.object({
        path: v.string(),
        etag: v.union(v.string(), v.null()),
        uploaded: v.union(v.number(), v.null()),
        current: v.boolean(),
        sealed: v.boolean(),
        props: v.union(v.string(), v.null()),
      }),
    ),
  ),
  handler: async (ctx, { workspaceId, paths }) => {
    if (paths.length > PROPS_AT_PATHS) throw new Error("nodes.props_at_too_many");
    if (!(await treeServesNow(ctx.db, workspaceId))) return null;
    const mirror = await readerMirror(ctx, workspaceId);
    // Rules that cannot be read publish nothing.
    if (mirror?.invalid === true) return [];
    const { rules, overrides } = await mirrorRules(mirror);
    const real = await sitePaths(ctx.db, workspaceId, paths);
    const found = [];
    for (const path of new Set(paths)) {
      if (!canSee(real(path), PUBLICATION_SCOPE, rules, overrides)) continue;
      const row = await liveNode(ctx.db, workspaceId, real(path));
      if (row === null) continue;
      found.push({
        path,
        etag: row.etag ?? null,
        uploaded: row.uploaded ?? null,
        current: factsCurrent(row) && !propsPredate(row),
        sealed: row.sealed === true,
        props: row.props ?? null,
      });
    }
    return found;
  },
});

/**
 * Which of `paths` the tree holds as a live note `clearance` may see: existence
 * as the bucket read answered it, from the tree alone and never a note's bytes.
 * Null when the tree is not served or its rules cannot be read, so a caller
 * says "can't tell" rather than guess.
 */
export const visibleNotes = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    paths: v.array(v.string()),
    scope: v.union(v.literal("private"), v.literal("team")),
    names: v.array(v.string()),
  },
  returns: v.union(v.null(), v.array(v.string())),
  handler: async (ctx, { workspaceId, paths, scope, names }) => {
    if (paths.length > PROPS_AT_PATHS) throw new Error("nodes.props_at_too_many");
    if (!(await treeServesNow(ctx.db, workspaceId))) return null;
    const mirror = await readerMirror(ctx, workspaceId);
    if (mirror?.invalid === true) return null;
    const { rules, overrides } = await mirrorRules(mirror);
    const granted = new Set(names);
    const real = await sitePaths(ctx.db, workspaceId, paths);
    const found = [];
    for (const path of new Set(paths)) {
      if (!canSee(real(path), scope, rules, overrides, granted)) continue;
      if ((await liveNode(ctx.db, workspaceId, real(path))) !== null) found.push(path);
    }
    return found;
  },
});
