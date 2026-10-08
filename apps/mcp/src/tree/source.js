/**
 * The tree table, as a bucket listing.
 *
 * `syncManifest` walks `store.list` and decides, key by key, what a caller may
 * see. Handing it a store whose `list` reads the tree table instead of the
 * bucket changes where the keys come from and nothing else: every privacy
 * decision is still `canSee` over the live `privacy.md`, which this store
 * still reads from the bucket. There is no second filter to drift.
 *
 * Only `list` is replaced. Every other method is the bucket's own, through the
 * prototype, so a read or a write through this store is a read or a write of
 * the bucket.
 */

import { TREE_PAGE_ROWS, listTreePage } from "./table.js";

export function treeListingStore(store, client, { pageRows = TREE_PAGE_ROWS } = {}) {
  const listing = Object.create(store);
  listing.list = async ({ prefix = "", cursor, startAfter } = {}) => {
    const after = typeof cursor === "string" && cursor !== "" ? cursor : startAfter;
    let rows;
    try {
      rows = await listTreePage(client, { prefix, after, limit: pageRows });
    } catch {
      // A database having a bad moment (or a page of very long paths over a
      // response cap) costs this page its speed, not the walk: the bucket
      // answers the same position in the same order.
      return await store.list({ prefix, ...(after === undefined ? {} : { startAfter: after }), limit: 1000 });
    }
    return {
      objects: rows.map((row) => ({
        key: row.path,
        ...(typeof row.etag === "string" && row.etag !== "" ? { etag: row.etag } : {}),
        ...(Number.isFinite(row.size) ? { size: row.size } : {}),
        ...(Number.isFinite(row.uploaded) ? { uploaded: new Date(row.uploaded) } : {}),
      })),
      truncated: rows.length === pageRows,
      ...(rows.length > 0 ? { cursor: rows[rows.length - 1].path } : {}),
    };
  };
  return listing;
}
