/**
 * The sweep: the tree's rows rebuilt from a listing of the bucket, a bounded
 * number of pages at a time, through the `NodeSink` seam (`table.ts`).
 *
 * This is the gateway's D1 tree sweep ported (that copy of the tree, and its
 * sweep, left in phase 7). The rules are the same and the seam is different:
 * the D1 version wrote SQL, this one calls the sink, whose
 * production form is a Convex mutation (`functions/nodes.ts`) and whose test
 * form runs the very same `observe.ts` rules over a Map.
 *
 * Why a resumable, key-ordered walk: a bucket can hold more keys than one
 * listing answers, and a sweep that restarted at the top on every pass would
 * never finish a large workspace. The last key listed is kept in the sink
 * after every page, and the next pass lists from just after it with
 * `startAfter`. That only works for a store that lists in byte order and
 * honours the position.
 *
 * **A store that does neither (Dropbox) is paged by its own continuation
 * token instead** (step 3 of the convex-only plan, 2026-10-14). Until then
 * the first out-of-order key marked the tree `unsupported` and it was never
 * served, so once every reader of which notes exist moved to the tree such a
 * workspace had no file list at all, and no write could ask whether a name
 * was taken. Now the pass starts the listing again from the top, unordered,
 * and keeps the store's token in the sink's cursor (`TOKEN_CURSOR`) so the
 * next pass resumes there. Rows are not position-dependent: the finish still
 * prunes whatever was not observed since the sweep began. The token is kept
 * only for such a store: it is opaque state the provider hands back for this
 * listing, and the control plane already holds every name it could stand
 * for. What remains `unsupported` is a store that says a listing has more and
 * offers neither a position nor a token, which nothing can page; it is tried
 * again a day later (`nodeSweepDue`).
 *
 * Why `.context/` and the other dot folders are jumped over: they hold one
 * object per AI read and sort ahead of every note, so walking them page by page
 * would spend a sweep's whole budget before the first note.
 */

import type { FileStore } from "../fileOps/store";
import { refreshPrivacyMirror } from "./privacyMirror";
import {
  NODE_PRIVACY_KEY,
  NODE_SWEEP_PAGES,
  OBSERVE_BATCH,
  nodeKey,
  type LeftAudiences,
  type NodeRow,
  type NodeSink,
  type Observation,
} from "./table";

/** The store operations a pass uses, and nothing else of the bucket. */
export type NodeListingStore = Pick<FileStore, "list" | "get">;

export interface SweepOptions {
  now?: () => number;
  maxPages?: number;
}

export interface SweepResult {
  complete: boolean;
  unsupported: boolean;
  pages: number;
  rows: number;
}

/**
 * What a failed pass records. Fixed and path-free on purpose: a storage error
 * can echo a private key, and the sink's `error` is shown to people.
 */
export const FILL_FAILED = "Tree fill failed; inspect service logs";

/**
 * Marks a cursor that is a store's continuation token rather than a key: no
 * key the sweep keeps begins with a control character (`nodeKey`), and an
 * ordered pass never stores one.
 */
export const TOKEN_CURSOR = "\u0001token\u0001";

/** A listing that said there was more and gave nothing new: it cannot make progress. */
const NO_PROGRESS = "the storage listing said there was more but returned nothing new";

/** `observe` answers `more` when its vanish scan ran out of budget; re-sends are bounded. */
const OBSERVE_TRIES = 20;

/** `prune` rounds one finish may take. A bound on a loop, not on a workspace. */
const PRUNE_ROUNDS = 1_000;

/** S3 lists in UTF-8 byte order, which is not JavaScript's string order. */
const KEY_BYTES = new TextEncoder();
export function compareKeys(a: string, b: string): number {
  const x = KEY_BYTES.encode(a);
  const y = KEY_BYTES.encode(b);
  const shared = Math.min(x.length, y.length);
  for (let index = 0; index < shared; index += 1) {
    if (x[index] !== y[index]) return x[index]! - y[index]!;
  }
  return x.length - y.length;
}

/** The dot-prefixed top-level folder a key lives under (`.context`), or null. */
export function plumbingRootOf(key: string): string | null {
  const slash = key.indexOf("/");
  if (slash <= 1 || !key.startsWith(".")) return null;
  return key.slice(0, slash);
}

/**
 * A listed object as a tree row, or null for a key the tree does not keep.
 *
 * A key is kept only as the tree spells it (`nodeKey(key) === key`): a
 * folder marker (`a/`) is its own row, and a key the tree would spell
 * differently (`/a`, `a//`) or a dot-prefixed one is skipped.
 */
export function rowFromObject(object: unknown): NodeRow | null {
  if (object === null || typeof object !== "object") return null;
  const meta = object as { key?: unknown; etag?: unknown; size?: unknown; uploaded?: unknown };
  if (typeof meta.key !== "string" || nodeKey(meta.key) !== meta.key) return null;
  const row: NodeRow = { path: meta.key };
  if (typeof meta.etag === "string" && meta.etag !== "") row.etag = meta.etag;
  if (typeof meta.size === "number" && Number.isFinite(meta.size)) row.size = meta.size;
  if (meta.uploaded !== undefined && meta.uploaded !== null) {
    const uploaded = new Date(meta.uploaded as string | number | Date).getTime();
    if (Number.isFinite(uploaded)) row.uploaded = uploaded;
  }
  return row;
}

/**
 * Sends rows and their vanish claims to the sink, `OBSERVE_BATCH` at a time.
 * `gone` goes with the first piece and `vanishedUnder` with the last, so a
 * scan of a folder runs once, after every row it must not undo has been seen.
 * Every write is idempotent, so a piece the sink asks for again is harmless.
 */
export async function observeAll(
  sink: NodeSink,
  at: number,
  rows: readonly NodeRow[],
  gone: readonly string[] = [],
  vanishedUnder: readonly string[] = [],
  left: readonly LeftAudiences[] = [],
): Promise<void> {
  if (rows.length === 0 && gone.length === 0 && vanishedUnder.length === 0) return;
  const pieces: NodeRow[][] = [];
  for (let index = 0; index < rows.length; index += OBSERVE_BATCH) {
    pieces.push(rows.slice(index, index + OBSERVE_BATCH));
  }
  if (pieces.length === 0) pieces.push([]);
  for (let index = 0; index < pieces.length; index += 1) {
    await observeOne(sink, {
      at,
      rows: pieces[index]!,
      gone: index === 0 ? [...gone] : [],
      vanishedUnder: index === pieces.length - 1 ? [...vanishedUnder] : [],
      // Every piece: a vanish scan in the last one may log a key leaving too.
      ...(left.length === 0 ? {} : { left: [...left] }),
    });
  }
}

async function observeOne(sink: NodeSink, observation: Observation): Promise<void> {
  for (let tries = 0; tries < OBSERVE_TRIES; tries += 1) {
    // `table.ts` types `observe` as void. The production mutation answers
    // `more` when its vanish scan ran out of budget, so the answer is read
    // structurally rather than trusted to be absent.
    const answer = (await sink.observe(observation)) as unknown as { more?: boolean } | undefined;
    if (answer?.more !== true) return;
  }
  throw new Error("observe did not settle");
}

/**
 * One pass of the sweep: list up to `maxPages` pages from wherever the sink
 * says the last pass stopped, record what they hold, and finish if the listing
 * ended. Returns whether the sweep finished and how far this pass got.
 *
 * A thrown error is recorded as `FILL_FAILED` and rethrown: the caller decides
 * whether to retry, and the label is all the tree ever shows.
 */
export async function sweepNodesPass(
  store: NodeListingStore,
  sink: NodeSink,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const now = options.now ?? Date.now;
  try {
    return await runPass(store, sink, now, options.maxPages ?? NODE_SWEEP_PAGES);
  } catch (error) {
    await sink.fail(FILL_FAILED).catch(() => undefined);
    throw error;
  }
}

async function runPass(
  store: NodeListingStore,
  sink: NodeSink,
  now: () => number,
  maxPages: number,
): Promise<SweepResult> {
  const begun = await sink.begin(now());
  const startedAt = begun.startedAt;
  let cursor = begun.cursor;
  if (cursor.startsWith(TOKEN_CURSOR)) {
    return await tokenPass(store, sink, now, maxPages, startedAt, cursor.slice(TOKEN_CURSOR.length), 0, 0);
  }
  let rows = 0;
  let sawPrivacy = false;

  for (let page = 0; page < maxPages; page += 1) {
    const observedAt = now();
    const listing = await store.list({ limit: 1000, ...(cursor === "" ? {} : { startAfter: cursor }) });
    const kept: NodeRow[] = [];
    let last = cursor;
    let jump: string | null = null;
    let privacyRow: NodeRow | null = null;
    for (const object of listing.objects ?? []) {
      const key = (object as { key?: unknown } | null)?.key;
      if (typeof key !== "string") continue;
      if (last !== "" && compareKeys(key, last) <= 0) {
        // Out of order, or the position was ignored: nothing after this is
        // "the rest". Start again from the top, by the store's own token,
        // and say so first, so a pass with no pages left resumes that way.
        await sink.progress(TOKEN_CURSOR, now());
        return await tokenPass(store, sink, now, maxPages - page - 1, startedAt, "", page + 1, rows);
      }
      last = key;
      const root = plumbingRootOf(key);
      if (root !== null) {
        // `${root}0` sorts after every key under `${root}/` and before anything else under the bucket.
        jump = `${root}0`;
        break;
      }
      const row = rowFromObject(object);
      if (row !== null) {
        kept.push(row);
        if (row.path === NODE_PRIVACY_KEY) privacyRow = row;
      }
    }
    // A page whose keys were all hidden (deleted notes' markers, which the
    // store does not list) shows nothing yet moves on: resume after the last
    // key the provider listed, or every pass asks for the same page again.
    // Ported from the D1 sweep's fix of 2026-10-08.
    const resumeAfter = (listing as { resumeAfter?: unknown }).resumeAfter;
    if (jump === null && typeof resumeAfter === "string" && compareKeys(resumeAfter, last) > 0) last = resumeAfter;
    rows += kept.length;
    await observeAll(sink, observedAt, kept);

    if (privacyRow !== null) {
      sawPrivacy = true;
      // Only a changed file is re-read: the mirror is already what the bucket
      // holds when the etag matches. Unless that copy did not parse: the same
      // bytes can read differently once the parser changes (a colon in a path,
      // 2026-10-14), and a mirror left invalid fails the whole workspace closed.
      const held = await sink.privacy();
      if (held?.etag !== privacyRow.etag || held?.invalid === true) await refreshPrivacyMirror(store, sink, now);
    }

    const finished = jump === null && listing.truncated !== true;
    const resumeAt = jump ?? last;
    if (!finished && jump === null && resumeAt === cursor) {
      await sink.fail(NO_PROGRESS);
      return { complete: false, unsupported: false, pages: page + 1, rows };
    }
    await sink.progress(resumeAt, now());
    if (finished) return await finishPass(store, sink, now, startedAt, sawPrivacy, page + 1, rows);
    cursor = resumeAt;
  }
  return { complete: false, unsupported: false, pages: maxPages, rows };
}

/**
 * The listing ended: settle the privacy mirror, prune what nobody observed
 * since the sweep began, and finish. Pruning comes first so the finished tree
 * never shows a row the bucket no longer holds.
 */
async function finishPass(
  store: NodeListingStore,
  sink: NodeSink,
  now: () => number,
  startedAt: number,
  sawPrivacy: boolean,
  pages: number,
  rows: number,
): Promise<SweepResult> {
  // A pass that never listed `privacy.md` (it sorts mid-bucket, and an earlier
  // pass may have had it) still has to notice that the file is gone.
  if (!sawPrivacy && (await sink.privacy())?.etag !== undefined) await refreshPrivacyMirror(store, sink, now);
  for (let round = 0; ; round += 1) {
    if (round >= PRUNE_ROUNDS) throw new Error("prune did not finish");
    const { more } = await sink.prune(startedAt);
    if (!more) break;
  }
  await sink.finish(now());
  return { complete: true, unsupported: false, pages, rows };
}

/**
 * Pages of a store that ignores key order, by its continuation token, from
 * `token` (`""` for the top). Every listed key outside a dot folder is
 * observed, in whatever order it comes; the token is kept after every page so
 * the next pass resumes there. A stored token the store no longer accepts is
 * dropped and the listing starts again from the top, once per pass.
 */
async function tokenPass(
  store: NodeListingStore,
  sink: NodeSink,
  now: () => number,
  maxPages: number,
  startedAt: number,
  token: string,
  pagesBefore: number,
  rowsBefore: number,
): Promise<SweepResult> {
  let rows = rowsBefore;
  let sawPrivacy = false;
  let retried = false;
  for (let page = 0; page < maxPages; page += 1) {
    const observedAt = now();
    let listing: Awaited<ReturnType<NodeListingStore["list"]>>;
    try {
      listing = await store.list({ limit: 1000, ...(token === "" ? {} : { cursor: token }) });
    } catch (error) {
      if (token === "" || retried) throw error;
      // An expired token: list from the top again rather than fail for ever.
      retried = true;
      token = "";
      page -= 1;
      continue;
    }
    const kept: NodeRow[] = [];
    let privacyRow: NodeRow | null = null;
    for (const object of listing.objects ?? []) {
      const key = (object as { key?: unknown } | null)?.key;
      if (typeof key !== "string" || plumbingRootOf(key) !== null) continue;
      const row = rowFromObject(object);
      if (row === null) continue;
      kept.push(row);
      if (row.path === NODE_PRIVACY_KEY) privacyRow = row;
    }
    rows += kept.length;
    await observeAll(sink, observedAt, kept);
    if (privacyRow !== null) {
      sawPrivacy = true;
      const held = await sink.privacy();
      if (held?.etag !== privacyRow.etag || held?.invalid === true) await refreshPrivacyMirror(store, sink, now);
    }
    const pages = pagesBefore + page + 1;
    if (listing.truncated !== true) return await finishPass(store, sink, now, startedAt, sawPrivacy, pages, rows);
    const next = typeof listing.cursor === "string" ? listing.cursor : "";
    if (next === "") {
      // More, and no way to ask for it: nothing can page this store.
      await sink.unsupported();
      return { complete: false, unsupported: true, pages, rows };
    }
    if (next === token) {
      await sink.fail(NO_PROGRESS);
      return { complete: false, unsupported: false, pages, rows };
    }
    token = next;
    await sink.progress(`${TOKEN_CURSOR}${token}`, now());
  }
  return { complete: false, unsupported: false, pages: pagesBefore + maxPages, rows };
}
