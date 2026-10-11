/**
 * The sweep: the tree table rebuilt from a listing of the bucket, a bounded
 * piece at a time.
 *
 * It is how a table is first filled, and how it is kept honest afterwards
 * about anything the write path did not see — a key changed by a tool that
 * writes the bucket directly, a change whose re-check failed. A finished sweep
 * removes every row nobody observed while it ran (`vanishedStatements`), so
 * what it leaves is what the bucket held, plus whatever the write path
 * observed since it began.
 *
 * Resumable: the last key listed is kept in `index_state` after every page,
 * and the next pass lists from just after it (`startAfter`, never the store's
 * continuation token, which is not ours to keep). A store that does not list
 * in key order or ignores the position (Dropbox) cannot be resumed this way,
 * so the first sign of it marks the table unsupported and it is never served.
 */

import {
  TREE_STATE,
  ensureTreeTables,
  observeStatements,
  plumbingRoot,
  pruneStatements,
  readTreeState,
  rowOf,
  setStateStatements,
  vanishedStatements,
} from "./table.js";

/** List pages one pass walks: about this many thousand keys. */
export const SWEEP_PAGES = 40;

/** A pass that ran this recently holds the sweep; another one waits. */
export const SWEEP_LEASE_MS = 5 * 60_000;

/** A table last swept longer ago than this is swept again when somebody reads it. */
export const SWEEP_STALE_MS = 60 * 60_000;

/** S3 lists in UTF-8 byte order, which is not JavaScript's string order. */
const KEY_BYTES = new TextEncoder();
export function compareKeys(a, b) {
  const x = KEY_BYTES.encode(a);
  const y = KEY_BYTES.encode(b);
  const shared = Math.min(x.length, y.length);
  for (let index = 0; index < shared; index += 1) {
    if (x[index] !== y[index]) return x[index] - y[index];
  }
  return x.length - y.length;
}

/** The sweep's start, kept at the earliest any pass recorded. */
function earliestStart(at) {
  return {
    sql: `INSERT INTO index_state (key, value) VALUES (?1, ?2)
          ON CONFLICT(key) DO UPDATE SET value = CAST(min(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
    params: [TREE_STATE.startedAt, String(at)],
  };
}

/** Whether a read of this state should start (or continue) a sweep. */
export function sweepDue(state, now) {
  if (state.unsupported) return false;
  if (state.leaseAt !== null && now - state.leaseAt < SWEEP_LEASE_MS) return false;
  if (state.cursor !== null) return true;
  if (!state.ready || state.dirty) return true;
  return state.sweptAt === null || now - state.sweptAt >= SWEEP_STALE_MS;
}

/**
 * One pass. Returns whether the sweep finished, and how far it got.
 *
 * @param {{ list: Function }} store the context's bucket
 * @param {{ query: Function, runAll: Function }} client its search database
 */
export async function sweepTreePass(store, client, options = {}) {
  try {
    return await sweepTreePassUnrecorded(store, client, options);
  } catch (error) {
    // Kept beside the table, in the context's own database, so a sweep that
    // fails at the same key every pass says why instead of only stalling.
    const now = options.now ?? Date.now;
    const message = String(error?.message ?? error).slice(0, 500);
    await client
      .runAll(setStateStatements({ [TREE_STATE.error]: message, [TREE_STATE.errorAt]: now() }))
      .catch(() => {});
    throw error;
  }
}

async function sweepTreePassUnrecorded(store, client, { now = Date.now, maxPages = SWEEP_PAGES } = {}) {
  await ensureTreeTables(client);
  const state = await readTreeState(client);
  if (state.unsupported) return { complete: false, unsupported: true, pages: 0, rows: 0 };

  const starting = state.cursor === null || state.startedAt === null;
  let cursor = starting ? "" : state.cursor;
  // A change too large to re-check key by key asked for this sweep; the sweep
  // lists everything from here on, so the request is answered once it starts.
  await client.runAll([
    ...setStateStatements({ [TREE_STATE.leaseAt]: now(), [TREE_STATE.dirty]: null }),
    ...(starting ? [...setStateStatements({ [TREE_STATE.cursor]: "" }), earliestStart(now())] : []),
  ]);
  // Two passes can start one sweep at the same moment. The earlier start is
  // kept, because the finish removes what nobody observed since the start, and
  // a later start would count rows the other pass observed as unobserved.
  const startedAt = (await readTreeState(client)).startedAt ?? now();

  let rows = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const observedAt = now();
    const listing = await store.list({ limit: 1000, ...(cursor === "" ? {} : { startAfter: cursor }) });
    const objects = listing.objects ?? [];
    const kept = [];
    let last = cursor;
    let jump = null;
    for (const object of objects) {
      const key = object?.key;
      if (typeof key !== "string") continue;
      if (last !== "" && compareKeys(key, last) <= 0) {
        // Out of order, or a position ignored: nothing after this is "the rest".
        await client.runAll(
          setStateStatements({
            [TREE_STATE.unsupported]: 1,
            [TREE_STATE.cursor]: null,
            [TREE_STATE.startedAt]: null,
          }),
        );
        return { complete: false, unsupported: true, pages: page + 1, rows };
      }
      last = key;
      const root = plumbingRoot(key);
      if (root !== null) {
        // `${root}0` sorts after every key under `${root}/` and before
        // anything that is not under it.
        jump = `${root}0`;
        break;
      }
      const row = rowOf(object);
      if (row !== null) kept.push(row);
    }
    rows += kept.length;
    // A page whose keys were all hidden (deleted notes' markers) lists nothing
    // yet moves on: resume after the last key the provider listed, or every
    // pass would ask for the same page again (2026-10-08).
    const resumeAfter = listing.resumeAfter;
    if (jump === null && typeof resumeAfter === "string" && compareKeys(resumeAfter, last) > 0) last = resumeAfter;

    const statements = observeStatements(kept, observedAt);
    const finished = jump === null && !listing.truncated;
    if (finished) {
      const at = now();
      const stored = (await readTreeState(client)).startedAt;
      statements.push(
        ...vanishedStatements("", stored === null ? startedAt : Math.min(stored, startedAt)),
        ...pruneStatements(at),
        ...setStateStatements({
          [TREE_STATE.ready]: 1,
          [TREE_STATE.sweptAt]: at,
          [TREE_STATE.cursor]: null,
          [TREE_STATE.startedAt]: null,
          [TREE_STATE.leaseAt]: null,
          [TREE_STATE.error]: null,
          [TREE_STATE.errorAt]: null,
        }),
      );
      await client.runAll(statements);
      return { complete: true, unsupported: false, pages: page + 1, rows };
    }
    if (jump === null && last === cursor) {
      // Truncated, yet nothing new: a store that cannot make progress.
      statements.push(
        ...setStateStatements({
          [TREE_STATE.error]: "the storage listing said there was more but returned nothing new",
          [TREE_STATE.errorAt]: now(),
        }),
      );
      await client.runAll(statements);
      return { complete: false, unsupported: false, pages: page + 1, rows };
    }
    cursor = jump ?? last;
    statements.push(
      ...setStateStatements({
        [TREE_STATE.cursor]: cursor,
        [TREE_STATE.leaseAt]: now(),
        [TREE_STATE.error]: null,
        [TREE_STATE.errorAt]: null,
      }),
    );
    await client.runAll(statements);
  }
  return { complete: false, unsupported: false, pages: maxPages, rows };
}
