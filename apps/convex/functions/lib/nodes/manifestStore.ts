/**
 * The whole-tree walk (`syncManifest`), answered from the Convex tree once it
 * serves the workspace (phase 2 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * A browser tab draws Home, pins, recents and its quick switcher from that
 * walk, and the desktop and phone apps feed their device copy from it. Before
 * this, it listed the per-workspace tree table or the bucket. Now it pages the
 * same rows the sidebar's live listings read, so every screen in a tab draws
 * from one tree.
 *
 * As with the live listing, nothing about privacy is decided here: the store
 * answers `list` from the rows and `privacy.md` from the tree's rules, and the
 * unchanged `syncManifest` decides what the caller sees with `canSee`.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps/store";
import { foldRows, type PendingMove } from "./moveOverlay";
import { mirrorFile } from "./privacyMirror";
import { NODE_PRIVACY_KEY, type NodeRow, type PrivacyMirror } from "./table";

/** One page of live file rows in key order, from just after `after`. */
export type NodePage = (after: string | undefined, limit: number) => Promise<{ rows: NodeRow[]; cursor: string | null }>;

/**
 * A store whose listings page the tree's rows and whose `privacy.md` is the
 * tree's rules. Every other read is the bucket's own, through the prototype,
 * as the retired D1 table's `treeListingStore` does it.
 *
 * The cursor it hands back is the last key of the page, a path the caller was
 * given, never anything about rows it was not.
 */
export function nodesPagedStore(
  base: FileStore,
  page: NodePage,
  mirror: PrivacyMirror | null,
  moves: readonly PendingMove[] = [],
): FileStore {
  const store = Object.create(base) as FileStore;
  // Non-enumerable, as the meaning index is attached: readers that list
  // differently from the tree ask these, and nothing walking the store carries them out.
  Object.defineProperty(store, SERVED, { value: true, enumerable: false });
  Object.defineProperty(store, MOVES, { value: moves, enumerable: false });
  let whole: Promise<NodeRow[]> | null = null;
  store.list = async (options) => {
    const prefix = options?.prefix ?? "";
    if (options?.delimiter === "/") {
      // One level, the whole of it in one answer, from one read of the tree
      // kept for the life of this store: a picker that lists folder after
      // folder reads the rows once, not once per folder.
      whole ??= everyRow(page);
      return oneLevel(await whole, prefix, options.cursor ?? options.startAfter);
    }
    const cursor = options?.cursor;
    let after = typeof cursor === "string" && cursor !== "" ? cursor : options?.startAfter;
    // Start at the prefix itself rather than at the top of the tree.
    if (prefix !== "" && (after === undefined || after < prefix)) after = prefix;
    const limit = options?.limit !== undefined && options.limit > 0 ? options.limit : 1000;
    const { rows, cursor: next } = await page(after, limit);
    const inside = rows.filter((row) => row.path.startsWith(prefix));
    // A row past the prefix means the rest of the tree is past it too.
    const done = next === null || inside.length < rows.length;
    return {
      objects: inside.map((row) => ({
        key: row.path,
        ...(row.etag !== undefined ? { etag: row.etag } : {}),
        ...(row.size !== undefined ? { size: row.size } : {}),
        ...(row.uploaded !== undefined ? { uploaded: new Date(row.uploaded) } : {}),
      })),
      truncated: !done,
      ...(done || rows.length === 0 ? {} : { cursor: rows[rows.length - 1]!.path }),
    };
  };
  store.get = async (key, ...rest) => {
    if (key !== NODE_PRIVACY_KEY) return await base.get(key, ...rest);
    return mirrorFile(mirror) as Awaited<ReturnType<FileStore["get"]>>;
  };
  return store;
}

/** Marks a store whose listings are the tree's (`isServedStore`). */
const SERVED = Symbol("nodesServed");
const MOVES = Symbol("nodesPendingMoves");

/** Whether `store` lists the Convex tree's rows rather than the bucket. */
export function isServedStore(store: FileStore): boolean {
  return (store as unknown as Record<symbol, unknown>)[SERVED] === true;
}

/** The pending moves a served store's rows are folded through; `[]` for any other store. */
export function servedMoves(store: FileStore): readonly PendingMove[] {
  const moves = (store as unknown as Record<symbol, unknown>)[MOVES];
  return Array.isArray(moves) ? (moves as PendingMove[]) : [];
}

/** Every key a served store lists, in key order: one read of the rows. */
export async function servedKeys(store: FileStore): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await store.list({ limit: FOLD_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects ?? []) keys.push(object.key);
    if (!page.truncated || page.cursor === undefined || page.cursor === cursor) return keys;
    if (keys.length >= WHOLE_TREE_ROWS) throw new Error("the tree did not finish within its row bound");
    cursor = page.cursor;
  }
}

/** Rows one whole-tree read takes before it stops: past the largest workspace. */
const WHOLE_TREE_ROWS = 250_000;

async function everyRow(page: NodePage): Promise<NodeRow[]> {
  const rows: NodeRow[] = [];
  let after: string | undefined;
  while (rows.length < WHOLE_TREE_ROWS) {
    const next = await page(after, FOLD_PAGE);
    rows.push(...next.rows);
    if (next.cursor === null || next.cursor === after || next.rows.length === 0) return rows;
    after = next.cursor;
  }
  // A walk that does not end is not a tree to draw from.
  throw new Error("the tree did not finish within its row bound");
}

/** A delimited listing of one folder from every row, as the S3 adapter answers it. */
function oneLevel(rows: readonly NodeRow[], prefix: string, after: string | undefined) {
  const objects: { key: string; etag?: string; size?: number; uploaded?: Date }[] = [];
  const folders = new Set<string>();
  for (const row of rows) {
    if (!row.path.startsWith(prefix)) continue;
    if (after !== undefined && after !== "" && row.path <= after) continue;
    const rest = row.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      objects.push({
        key: row.path,
        ...(row.etag !== undefined ? { etag: row.etag } : {}),
        ...(row.size !== undefined ? { size: row.size } : {}),
        ...(row.uploaded !== undefined ? { uploaded: new Date(row.uploaded) } : {}),
      });
    } else {
      folders.add(`${prefix}${rest.slice(0, slash + 1)}`);
    }
  }
  return { objects, delimitedPrefixes: [...folders], truncated: false };
}

/**
 * The store a walk of this workspace reads when the tree serves it, or `null`
 * when it does not (not yet proved, failing, or staff paused the migration),
 * and the walk reads what it read before.
 */
export async function servedNodesStore(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  base: FileStore,
): Promise<FileStore | null> {
  const served = await ctx.runQuery(internal.functions.nodes.served, { workspaceId });
  if (served === null) return null;
  const listed: NodePage = async (after, limit) => {
    const result = await ctx.runQuery(internal.functions.nodes.listLive, {
      workspaceId,
      limit,
      ...(after === undefined ? {} : { after }),
    });
    return {
      rows: result.rows.map((row) => ({
        path: row.path,
        ...(row.etag === undefined ? {} : { etag: row.etag }),
        ...(row.size === undefined ? {} : { size: row.size }),
        ...(row.uploaded === undefined ? {} : { uploaded: row.uploaded }),
      })),
      cursor: result.cursor,
    };
  };
  const moves = await ctx.runQuery(internal.functions.nodeMoves.active, { workspaceId });
  return nodesPagedStore(base, moves.length === 0 ? listed : foldedPages(listed, moves), served.mirror, moves);
}

/** Rows one read of the whole tree takes per page while moves are pending. */
const FOLD_PAGE = 2_000;

/**
 * Pages of the tree as drawn while moves are pending (`moveOverlay.ts`).
 * Folding renames keys out of order, so the rows are read once, folded and
 * sorted, and paged from that; the cursor is still the last path handed out.
 */
export function foldedPages(listed: NodePage, moves: readonly PendingMove[]): NodePage {
  let all: Promise<NodeRow[]> | null = null;
  const readAll = async () => {
    const seen = new Set<string>();
    const rows: NodeRow[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await listed(after, FOLD_PAGE);
      rows.push(...foldRows(page.rows, moves, seen));
      if (page.cursor === null || page.cursor === after || page.rows.length === 0) break;
      after = page.cursor;
    }
    return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  };
  return async (after, limit) => {
    all ??= readAll();
    const rows = await all;
    let low = 0;
    let high = rows.length;
    while (after !== undefined && low < high) {
      const middle = (low + high) >> 1;
      if (rows[middle]!.path <= after) low = middle + 1;
      else high = middle;
    }
    const slice = rows.slice(low, low + limit);
    return { rows: slice, cursor: low + limit >= rows.length || slice.length === 0 ? null : slice[slice.length - 1]!.path };
  };
}
