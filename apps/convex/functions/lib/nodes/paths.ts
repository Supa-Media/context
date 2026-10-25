/**
 * A row's path, built from its parents and names, and the row at a path, found
 * by walking down from the top (`paths-on-read.md`, stage 4). Parent pointers
 * are the tree's truth: a move changes the moved row's `parentId` and `name`
 * and nothing under it, so a path read here is where a row is now, whatever
 * its stored `path` still says.
 *
 * Every reader that moves off the stored `path` goes through here, so how a
 * path is spelled is decided once: segments joined by `/`, a folder marker row
 * named `""` under the folder it marks (`a/`). One `TreePaths` is made per
 * request; it remembers the folders it has walked, so the rows of one folder
 * cost one walk between them.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";

/** Deeper than any real tree: a chain longer than this is a loop, and its row has no path. */
export const PATH_DEPTH_MAX = 256;

type Row = Doc<"nodes">;

export interface TreePaths {
  /** The row's path from its parents, or `null` when a parent is missing, in another workspace, or a loop. */
  pathOf(row: Row): Promise<string | null>;
  /** The row at `path`, live where one is, else a gone one; `null` when no row's parents spell it. */
  rowAt(path: string): Promise<Row | null>;
  /** The live row at `path`, or `null`. */
  liveAt(path: string): Promise<Row | null>;
}

/** Prefer the live row; a name that holds only gone rows answers the newest of them. */
function pick(rows: Row[]): Row | null {
  const live = rows.find((row) => row.goneAt === undefined);
  if (live !== undefined) return live;
  return rows.length === 0 ? null : rows.reduce((a, b) => ((b.goneAt ?? 0) > (a.goneAt ?? 0) ? b : a));
}

export function treePaths(db: DatabaseReader, workspaceId: Id<"workspaces">): TreePaths {
  const pathById = new Map<Id<"nodes">, string | null>();
  const rowByPath = new Map<string, Row | null>();

  async function pathOf(row: Row): Promise<string | null> {
    if (row.workspaceId !== workspaceId) return null;
    const known = pathById.get(row._id);
    if (known !== undefined) return known;
    // Walk up to the first folder already known, or the top, then name the chain on the way back.
    const chain: Row[] = [row];
    let base: string | null | undefined = undefined;
    for (let at = row; ; ) {
      if (at.parentId === undefined) {
        base = "";
        break;
      }
      const cached = pathById.get(at.parentId);
      if (cached !== undefined) {
        base = cached;
        break;
      }
      if (chain.length > PATH_DEPTH_MAX) {
        base = null;
        break;
      }
      const parent = await db.get(at.parentId);
      if (parent === null || parent.workspaceId !== workspaceId || parent.kind !== "folder") {
        base = null;
        break;
      }
      chain.push(parent);
      at = parent;
    }
    let path: string | null = base;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const link = chain[index];
      path = path === null ? null : path === "" && link.parentId === undefined ? link.name : `${path}/${link.name}`;
      pathById.set(link._id, path);
    }
    return path;
  }

  async function childNamed(parentId: Id<"nodes"> | undefined, name: string): Promise<Row[]> {
    return await db
      .query("nodes")
      .withIndex("by_parent_name", (q) => q.eq("workspaceId", workspaceId).eq("parentId", parentId).eq("name", name))
      .take(16);
  }

  async function rowAt(path: string): Promise<Row | null> {
    if (path === "") return null;
    const known = rowByPath.get(path);
    if (known !== undefined) return known;
    const slash = path.lastIndexOf("/");
    let parentId: Id<"nodes"> | undefined;
    if (slash >= 0) {
      const parent = await rowAt(path.slice(0, slash));
      if (parent === null || parent.kind !== "folder") {
        rowByPath.set(path, null);
        return null;
      }
      parentId = parent._id;
    }
    const row = pick(await childNamed(parentId, path.slice(slash + 1)));
    rowByPath.set(path, row);
    if (row !== null) pathById.set(row._id, path);
    return row;
  }

  async function liveAt(path: string): Promise<Row | null> {
    const row = await rowAt(path);
    return row !== null && row.goneAt === undefined ? row : null;
  }

  return { pathOf, rowAt, liveAt };
}

/** Whether this workspace's readers build paths from parents (`nodeTrees.paths`). */
export async function pathsBuilt(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<boolean> {
  const tree = await db
    .query("nodeTrees")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return tree?.paths === "built";
}

/** The same answers from the stored `path`: what every reader read before the switch. */
export function storedPaths(db: DatabaseReader, workspaceId: Id<"workspaces">): TreePaths {
  async function rowAt(path: string): Promise<Row | null> {
    if (path === "") return null;
    return pick(
      await db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
        .take(16),
    );
  }
  return {
    pathOf: async (row) => (row.workspaceId === workspaceId ? row.path : null),
    rowAt,
    liveAt: async (path) => {
      const row = await rowAt(path);
      return row !== null && row.goneAt === undefined ? row : null;
    },
  };
}

/**
 * The paths this workspace's readers use now: built from parents once its switch is flipped, else the stored
 * ones. A reader that takes its paths from here reads the same answer either way while the two agree, which the
 * `Tree parents` check confirms before a workspace is flipped.
 */
export async function nodePaths(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<TreePaths & { built: boolean }> {
  const built = await pathsBuilt(db, workspaceId);
  return { ...(built ? treePaths(db, workspaceId) : storedPaths(db, workspaceId)), built };
}
