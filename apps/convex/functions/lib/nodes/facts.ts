/**
 * What notes' text says about them, kept in Convex beside the rows they name
 * (decided by the owner, 2026-10-13): each note's links (`nodeLinks`) and its
 * front matter (`props` on its own `nodes` row). Until then both lived in the
 * workspace's search database (`tree_links`, `tree_props`, retired with the
 * D1 tree in phase 7), each filled by a chain that walked the whole D1 tree
 * to find what had changed; here the tree's own change log (`nodeLog`) says
 * which notes to read again, and one read of a note fills both, parsed by the
 * gateway's `linkRowsOf` and `propsOf`.
 *
 * ## How the facts follow the tree
 *
 * A first fill walks every note once, in key order (`after`), having noted
 * where the change log stood when it began (`startSeq`). From then on, each
 * pass reads the log after `seq`, and every note it names whose row's
 * `parsed` version differs from its `etag` is read from the bucket again. A
 * note the log says has gone loses its links (its row, and its props with
 * it, is the tree's to remove). A log too old to reach back to `seq` (rows
 * are kept 30 days) starts a fresh walk.
 *
 * A log row commits a moment after its `seq` is taken, so a pass re-reads the
 * last minute of log each time (`FACT_LOG_OVERLAP`); the version check makes
 * that cost a query, not a bucket read.
 *
 * ## What the readers trust
 *
 * The props of a row only at its own version: a stale row is read again from
 * the bucket by the List that wanted it, as the D1 table's were. The links
 * only once `ready` (every note read at least once). Notes changed since (the
 * log past `seq`, and any whose read failed, `retry`) are **unparsed**: the
 * map counts them to say it is catching up, and a move treats each as a
 * candidate whatever it held, so a stale row costs a read but never a missed
 * link.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../../../_generated/server";
import { expiredBefore, seqAt } from "./log";
import { CONTACTS_FOLDER, asInboxKey } from "../../../../../packages/communications/src/protocol.js";
import { hasReview, isExempt, LONG_NOTE_LINES } from "../../../../mcp/src/chaos/rubric.js";
import { nodeAt } from "./paths";

/** Notes one fill pass reads from the bucket. */
export const FACT_FILL_NOTES = 200;
/** Notes read at once. */
export const FACT_FILL_CONCURRENCY = 8;
/** Link rows one `record` mutation writes, so a note full of links never overruns a transaction. */
export const FACT_RECORD_ROWS = 2_000;
/** Log rows one pass looks through. */
export const FACT_LOG_PAGE = 1_000;
/** Seconds of log re-read each pass, for appends that committed after a later `seq`. */
export const FACT_LOG_OVERLAP = seqAt(60_000) - seqAt(0);
/** A pass holds the fill this long; one that died lets the next start after it. */
export const FACT_LEASE_MS = 2 * 60_000;
/** Passes one chain runs before it waits for the next trigger. */
export const FACT_FILL_CHAIN = 50;
/** Notes whose read failed, kept to try again (and counted as unparsed meanwhile). */
export const FACT_RETRY_CAP = 200;
/** More unparsed notes than this and a move walks every note instead of trusting the rows. */
export const MOVE_UNPARSED_CAP = 500;
/** Renamed paths one candidates read answers; past it, the move walks. */
export const MOVE_RENAMES_CAP = 2_000;
/** Link rows one map page reads. */
export const LINK_PAGE_ROWS = 4_000;

/** Paths one `propsAt` read names: few enough that their props stay well inside one answer. */
export const PROPS_AT_PATHS = 100;
/** Days of chaos scores kept, as the search database kept them: enough for "this week" and "this month". */
export const CHAOS_DAYS = 35;

/** `YYYY-MM-DD` in UTC. */
export function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** A note the facts follow: Markdown, as the D1 tables counted one. */
export function isFactNote(path: string): boolean {
  return path.endsWith(".md");
}

/** `1-projects/x/overview.md` → `overview`: what a bare link to it is written as. */
export function bareNameOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

export interface FactState {
  ready: boolean;
  seq: number;
  after?: string;
  startSeq?: number;
  leaseAt?: number;
  retry?: string[];
  /**
   * A ready fill still re-reading notes whose props predate `PROPS_VERSION`:
   * the last path that walk reached (`""` before the first). Readers keep
   * trusting the rows meanwhile; only the notes it re-reads change.
   */
  upgrade?: string;
  /** Set by the pass whose upgrade walk reached the end. */
  upgraded?: boolean;
}

export async function factStateRow(db: DatabaseReader, workspaceId: Id<"workspaces">) {
  return await db
    .query("nodeFactState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** The change log's newest `seq` now, or where the clock would put one. */
export async function logHead(db: DatabaseReader, workspaceId: Id<"workspaces">, now: number): Promise<number> {
  const last = await db
    .query("nodeLog")
    .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId))
    .order("desc")
    .first();
  return last?.seq ?? seqAt(now);
}

/** A walk from the first note, begun at the log's head. */
export function freshWalk(head: number): FactState {
  return { ready: false, seq: head, startSeq: head };
}

/**
 * Whether the log still reaches back to `seq`. Rows older than the keeping
 * window are pruned, so a fill that fell further behind cannot tell what it
 * missed and walks again.
 */
export function logReaches(state: FactState, now: number): boolean {
  return state.seq >= expiredBefore(now);
}

/**
 * Whether a fill should start: never filled, mid-walk, the log moved past
 * `seq`, or reads to retry, and no pass holding it.
 */
export async function factsDue(db: DatabaseReader, workspaceId: Id<"workspaces">, now: number): Promise<boolean> {
  const row = await factStateRow(db, workspaceId);
  if (row === null) return true;
  if (row.leaseAt !== undefined && now - row.leaseAt < FACT_LEASE_MS) return false;
  if (!row.ready || (row.retry?.length ?? 0) > 0 || row.propsVersion !== PROPS_VERSION) return true;
  const next = await db
    .query("nodeLog")
    .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId).gt("seq", row.seq))
    .first();
  return next !== null;
}

/** Bytes of props one row keeps. A note past it stays unparsed and its List reads it from the bucket. */
export const PROPS_BYTES = 32_000;

export interface ChaosExtra {
  lines: number | null;
  exempt: boolean;
  review: boolean;
}

/**
 * What the chaos score needs beyond a note's key (`scoreKeys`' extras in
 * `apps/mcp/src/chaos/live.js`), or `null` for a note it needs nothing more
 * of: one past the long-note line, or a contact page carrying a `review:`.
 */
export function chaosExtraOf(path: string, props: string | null | undefined): ChaosExtra | null {
  if (props === null || props === undefined) return null;
  let parsed: { lines?: unknown; properties?: Record<string, unknown> };
  try {
    parsed = JSON.parse(props);
  } catch {
    return null;
  }
  const properties = parsed.properties ?? {};
  const lines = typeof parsed.lines === "number" && Number.isFinite(parsed.lines) ? parsed.lines : null;
  const review = hasReview(properties.review);
  const long = lines !== null && lines > LONG_NOTE_LINES;
  if (!long && !(asInboxKey(path).startsWith(`${CONTACTS_FOLDER}/`) && review)) return null;
  return { lines, exempt: isExempt(path, properties.type, properties.generated), review };
}

/** A note's live row, or `null` when it is not in the tree. */
export async function liveNode(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string) {
  const row = await nodeAt(db, workspaceId, path);
  return row === null || row.goneAt !== undefined || row.kind !== "file" ? null : row;
}

/** Whether a row's facts were read at its current version. A row with no version cannot say it changed. */
export function factsCurrent(row: { etag?: string; parsed?: string }): boolean {
  return row.parsed !== undefined && (row.etag === undefined || row.parsed === row.etag);
}

/**
 * What a row's props carry, by version: 2 added `site` (`siteFlagsOf`, the
 * website restriction flags a public list asks instead of opening the page).
 * A fill whose state names an older version walks every note once more and
 * reads the ones whose props predate it (`propsPredate`).
 */
export const PROPS_VERSION = 2;

/** A row read before its props carried `site`: the fill reads it again; a website list does not trust it. */
export function propsPredate(row: { props?: string; sealed?: boolean }): boolean {
  return row.sealed !== true && row.props !== undefined && !row.props.includes('"site":');
}

/** Whether one note still has links recorded. */
export async function hasLinks(db: DatabaseReader, workspaceId: Id<"workspaces">, source: string): Promise<boolean> {
  const row = await db
    .query("nodeLinks")
    .withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId).eq("source", source))
    .first();
  return row !== null;
}

/** Remove every link one note held. */
export async function dropLinks(db: DatabaseWriter, workspaceId: Id<"workspaces">, source: string): Promise<void> {
  const rows = await db
    .query("nodeLinks")
    .withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId).eq("source", source))
    .collect();
  for (const row of rows) await db.delete(row._id);
}

/**
 * Record one note's facts on its row: its links replaced, and its props
 * (`null` for an encrypted note) at the version it was read at.
 */
export async function writeFacts(
  db: DatabaseWriter,
  row: Doc<"nodes">,
  facts: { links: ReadonlyArray<readonly [string, string]>; props: string | null },
): Promise<void> {
  await dropLinks(db, row.workspaceId, row.path);
  // More links than one write may hold: the first are kept and the note stays
  // unparsed, so a move still reads it rather than trust a short list.
  const overflow = facts.links.length > FACT_RECORD_ROWS;
  for (const [kind, target] of facts.links.slice(0, FACT_RECORD_ROWS)) {
    if (kind !== "path" && kind !== "name") continue;
    await db.insert("nodeLinks", { workspaceId: row.workspaceId, source: row.path, kind, target });
  }
  const tooLarge = facts.props !== null && facts.props.length > PROPS_BYTES;
  await db.patch(row._id, {
    // A row too large to keep props for stays unparsed: its List reads the note.
    parsed: tooLarge || overflow ? undefined : (row.etag ?? ""),
    props: facts.props === null || tooLarge ? undefined : facts.props,
    sealed: facts.props === null ? true : undefined,
    chaosNote: !tooLarge && chaosExtraOf(row.path, facts.props) !== null ? true : undefined,
  });
}
