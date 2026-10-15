/**
 * The map's link table (`workspaceGraph` in `lib/fileOps/graph.ts`): every
 * note and every link, read without opening a note, from the Convex tree's
 * rows and its facts (`nodeLinks`, `lib/nodes/facts.ts`) once they have read
 * every note. Elsewhere the map reads the search index (the search
 * database's `tree_links` it replaced left in phase 7). It rides on the store
 * the barrier hands the map, non-enumerable, as the meaning index does, so
 * nothing that walks the store carries it out.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps/store";
import { isFactNote } from "./facts";
import { servedKeys } from "./manifestStore";

export interface LinkTable {
  /** Every note's bucket key and every link as `[source, kind, target]`. */
  read(): Promise<{ paths: string[]; links: string[][] }>;
  /** Notes changed since their links were read: the map is "catching up". */
  unparsed: number;
}

/** Pages of `nodeLinks` one map read follows before it gives up on the rows. */
const LINK_PAGES = 250;

export function attachLinkTable(store: FileStore, table: LinkTable): FileStore {
  Object.defineProperty(store, "linkTable", { value: table, enumerable: false, configurable: true });
  return store;
}

export function linkTableOf(store: FileStore): LinkTable | null {
  const table = (store as unknown as { linkTable?: LinkTable }).linkTable;
  return table && typeof table === "object" && typeof table.read === "function" ? table : null;
}

/** Every link Convex holds for one workspace, in source order. */
export async function convexLinkRows(ctx: Pick<ActionCtx, "runQuery">, workspaceId: Id<"workspaces">): Promise<string[][]> {
  const links: string[][] = [];
  let cursor: string | null = null;
  for (let page = 0; page < LINK_PAGES; page += 1) {
    const result: { rows: string[][]; cursor: string; done: boolean } = await ctx.runQuery(internal.functions.nodeFacts.page, {
      workspaceId,
      cursor,
    });
    links.push(...result.rows);
    if (result.done) return links;
    cursor = result.cursor;
  }
  throw new Error("nodes.links_too_many");
}

/**
 * Convex's table for a served store, or `null` while its facts have not read
 * every note once (the fill is then started, and the map reads the search
 * index meanwhile). Notes are the served rows; links are
 * `nodeLinks`, whose sources the fill drops as their notes go.
 */
export async function convexLinkTable(
  ctx: Pick<ActionCtx, "runQuery">,
  workspaceId: Id<"workspaces">,
  served: FileStore,
): Promise<LinkTable | null> {
  const readiness = await ctx.runQuery(internal.functions.nodeFacts.readiness, { workspaceId });
  if (!readiness.ready) return null;
  return {
    unparsed: readiness.unparsed,
    read: async () => {
      const [keys, links] = await Promise.all([servedKeys(served), convexLinkRows(ctx, workspaceId)]);
      return { paths: keys.filter(isFactNote), links };
    },
  };
}
