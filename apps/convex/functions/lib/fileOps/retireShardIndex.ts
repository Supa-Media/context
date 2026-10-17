/**
 * The bucket's shard index, deleted from a context its search database serves.
 *
 * Decided by the owner, 2026-10-17 ("Yes, all of it" on moving search onto the
 * database only and deleting the index files in storage). Since then nothing
 * reads or maintains `.context/search/v2/` for a context with a search
 * database (`gateway-search-and-projection.md`), so its files are a disposable
 * derivative nobody uses, taking up the customer's bucket. They go on the
 * daily check of a `ready` database (`filesFns/prunePass.ts`), a bounded batch
 * per link, and the check's chain carries on while some are left.
 *
 * ## Only these keys, and never search by meaning's
 *
 * `isRetiredShardKey` is an allow-list, not a prefix: the shard index's own
 * files (`v2/`, and the single-file `search-v1.json` before it), at their
 * current and legacy (`.index/`) places. Search by meaning keeps its catch-up
 * state beside them under `.context/search/meaning/`, and losing that state
 * re-embeds a whole context, so a key under any `meaning/` is refused even if
 * a listing returned it.
 *
 * ## Turning it back
 *
 * A context whose database is turned off searches the bucket again, and the
 * first searches rebuild the shard index from the notes, as for any context
 * without one: deleting a derivative loses nothing. `SHARD_INDEX_RETIRE=off`
 * in the deployment's environment stops the deletes without a deploy.
 */

import type { FileStore } from "./store";

const CURRENT = ".context/search/";
const LEGACY = ".index/";

/** Files one link may delete; the chain does the rest. */
export const RETIRE_DELETE_CAP = 500;

/** Is `key` one of the shard index's own files? Nothing else is ever deleted here. */
export function isRetiredShardKey(key: string): boolean {
  if (typeof key !== "string" || key.includes("/meaning/") || key.includes("..")) return false;
  for (const root of [CURRENT, LEGACY]) {
    if (key === `${root}search-v1.json`) return true;
    if (key.startsWith(`${root}v2/`) && key.length > `${root}v2/`.length) return true;
  }
  return false;
}

/** Whether the deployment lets this run: on unless `SHARD_INDEX_RETIRE` is `off`. */
export function shardRetireEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SHARD_INDEX_RETIRE ?? "").trim().toLowerCase() !== "off";
}

/**
 * Delete up to `cap` of the shard index's files. `more` when the cap stopped
 * it, so the caller chains another link. A listing or a delete that fails
 * stops this link with what it did; the next day's check tries again.
 */
export async function retireShardIndex(
  store: FileStore,
  { cap = RETIRE_DELETE_CAP }: { cap?: number } = {},
): Promise<{ deleted: number; more: boolean }> {
  let deleted = 0;
  try {
    for (const root of [CURRENT, LEGACY]) {
      const single = `${root}search-v1.json`;
      if (deleted >= cap) return { deleted, more: true };
      // A HEAD where the adapter has one: the old single-file index can be megabytes.
      const present = typeof store.head === "function" ? await store.head(single) : await store.get(single);
      if (present !== null) {
        await store.delete(single);
        deleted += 1;
      }
      let cursor: string | undefined;
      do {
        const page = await store.list({ prefix: `${root}v2/`, ...(cursor ? { cursor } : {}) });
        for (const object of page.objects ?? []) {
          if (!isRetiredShardKey(object.key)) continue;
          if (deleted >= cap) return { deleted, more: true };
          await store.delete(object.key);
          deleted += 1;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
  } catch {
    return { deleted, more: false };
  }
  return { deleted, more: false };
}
