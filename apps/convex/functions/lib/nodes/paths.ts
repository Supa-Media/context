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
 * cost one walk between them. A writer, whose writes would leave that memory
 * behind, asks afresh each time (`nodeAt`).
 *
 * A row handed out here carries the path it was found at as its `path`, built
 * or stored, so a reader that goes on to read `row.path` reads where the row is
 * now and never the stored column.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";

/** Deeper than any real tree: a chain longer than this is a loop, and its row has no path. */
export const PATH_DEPTH_MAX = 256;

type Row = Doc<"nodes">;

/** Answers `false` to stop a walk. */
export type RowVisit = (row: Row) => boolean | void | Promise<boolean | void>;

export interface TreePaths {
  /** The row's path from its parents, or `null` when a parent is missing, in another workspace, or a loop. */
  pathOf(row: Row): Promise<string | null>;
  /** The row at `path`, live where one is, else a gone one; `null` when no row's parents spell it. */
  rowAt(path: string): Promise<Row | null>;
  /** The live row at `path`, or `null`. */
  liveAt(path: string): Promise<Row | null>;
  /**
   * Every row beneath `path`, live and gone, the row at `path` itself not among them, each carrying its path;
   * stops when `visit` answers `false`. Answers `false` when it stopped. Stored paths come in path order, built
   * ones depth first by name: callers that page keep to one source. `""` has nothing beneath it here; the
   * whole workspace is `walk("", ...)`.
   */
  below(path: string, visit: RowVisit): Promise<boolean>;
  /**
   * Every row beneath `root` (`""`: the whole workspace) after the path `after`, in this source's order, as
   * `below` gives them: what a reader paging through the tree resumes from. A row moved away since its page
   * was read may be read again, or not, at its new name.
   */
  walk(root: string, after: string | undefined, visit: RowVisit): Promise<boolean>;
  /** The rows `walk` visits, to read with `for await`. */
  rows(root: string, after: string | undefined): AsyncIterable<Row>;
}

/** `walk` and `below` over a source's `rows`. */
function walkers(rows: TreePaths["rows"]): Pick<TreePaths, "walk" | "below"> {
  const walk = async (root: string, after: string | undefined, visit: RowVisit): Promise<boolean> => {
    for await (const row of rows(root, after)) if ((await visit(row)) === false) return false;
    return true;
  };
  return {
    walk,
    below: async (path, visit) => (path === "" ? true : await walk(path, undefined, visit)),
  };
}

/** The row as a reader is handed it: at `path`, where it is now. */
function at(row: Row, path: string): Row {
  return row.path === path ? row : { ...row, path };
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
    for (let at = row; ;) {
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
    const found = pick(await childNamed(parentId, path.slice(slash + 1)));
    const row = found === null ? null : at(found, path);
    rowByPath.set(path, row);
    if (row !== null) pathById.set(row._id, path);
    return row;
  }

  async function liveAt(path: string): Promise<Row | null> {
    const row = await rowAt(path);
    return row !== null && row.goneAt === undefined ? row : null;
  }

  const join = (parentPath: string, name: string) => (parentPath === "" ? name : `${parentPath}/${name}`);
  const childrenAfter = (parentId: Id<"nodes"> | undefined, name: string | undefined) =>
    db.query("nodes").withIndex("by_parent_name", (q) => {
      const level = q.eq("workspaceId", workspaceId).eq("parentId", parentId);
      return name === undefined ? level : level.gt("name", name);
    });

  /** The rows of the folder `parentId` (the top for `undefined`) after `name`, each followed by everything beneath it. */
  async function* levelRows(
    parentId: Id<"nodes"> | undefined,
    parentPath: string,
    name: string | undefined,
    depth: number,
  ): AsyncGenerator<Row> {
    if (depth > PATH_DEPTH_MAX) return;
    for await (const child of childrenAfter(parentId, name)) {
      const path = join(parentPath, child.name);
      yield at(child, path);
      if (child.kind === "folder") yield* levelRows(child._id, path, undefined, depth + 1);
    }
  }

  async function* rows(root: string, after: string | undefined): AsyncGenerator<Row> {
    let rootId: Id<"nodes"> | undefined;
    if (root !== "") {
      const row = await rowAt(root);
      if (row === null || row.kind !== "folder") return;
      rootId = row._id;
    }
    const base = root === "" ? "" : `${root}/`;
    if (after === undefined || !after.startsWith(base)) {
      yield* levelRows(rootId, root, undefined, 1);
      return;
    }
    // Resume after `after`: what is beneath it, then each level's later names, innermost level first.
    const names = after.slice(base.length).split("/");
    const chain: { id: Id<"nodes"> | undefined; path: string }[] = [{ id: rootId, path: root }];
    for (const name of names) {
      const parent = chain[chain.length - 1];
      const row = pick(await childNamed(parent.id, name));
      if (row === null || row.kind !== "folder") break;
      chain.push({ id: row._id, path: join(parent.path, name) });
    }
    if (chain.length === names.length + 1) {
      const reached = chain[chain.length - 1];
      yield* levelRows(reached.id, reached.path, undefined, chain.length);
    }
    for (let level = Math.min(names.length, chain.length) - 1; level >= 0; level -= 1) {
      const parent = chain[level];
      yield* levelRows(parent.id, parent.path, names[level], level + 1);
    }
  }

  return { pathOf, rowAt, liveAt, rows, ...walkers(rows) };
}

/**
 * Whether this workspace's readers build paths from parents (`nodeTrees.paths`). `CONTEXT_TREE_PATHS=built` builds
 * them for every workspace, whatever its row says: how the suite runs every test against built paths.
 */
export async function pathsBuilt(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<boolean> {
  if (process.env.CONTEXT_TREE_PATHS === "built") return true;
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
  async function* rows(root: string, after: string | undefined): AsyncGenerator<Row> {
    const prefix = root === "" ? "" : `${root}/`;
    // From the folder's marker (`a/`, a row beneath it as a built path has it) on, or from after `after`.
    const resume = after !== undefined && after.startsWith(prefix) && after >= prefix ? after : undefined;
    const found = db.query("nodes").withIndex("by_workspace_path", (q) => {
      const scoped = q.eq("workspaceId", workspaceId);
      if (resume !== undefined) return scoped.gt("path", resume);
      return prefix === "" ? scoped : scoped.gte("path", prefix);
    });
    for await (const row of found) {
      if (!row.path.startsWith(prefix)) return;
      yield row;
    }
  }
  return {
    pathOf: async (row) => (row.workspaceId === workspaceId ? row.path : null),
    rowAt,
    liveAt: async (path) => {
      const row = await rowAt(path);
      return row !== null && row.goneAt === undefined ? row : null;
    },
    rows,
    ...walkers(rows),
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

/** The row at `path` now (`TreePaths.rowAt`), asked afresh: what a writer, or a reader of one row, calls. */
export async function nodeAt(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string): Promise<Row | null> {
  return await (await nodePaths(db, workspaceId)).rowAt(path);
}

/** The live row at `path` now, asked afresh. */
export async function liveNodeAt(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string): Promise<Row | null> {
  return await (await nodePaths(db, workspaceId)).liveAt(path);
}

/** `row` at the path it is at now, or `null` when its parents spell none: for a row found by another index. */
export async function located(db: DatabaseReader, row: Row, paths?: TreePaths): Promise<Row | null> {
  const path = await (paths ?? (await nodePaths(db, row.workspaceId))).pathOf(row);
  return path === null ? null : at(row, path);
}

/** Up to `limit` rows beneath `root` (`""`: all of them) after the path `after`, as `TreePaths.walk` gives them. */
export async function rowsAfter(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  root: string,
  after: string | undefined,
  limit: number,
): Promise<Row[]> {
  const rows: Row[] = [];
  if (limit <= 0) return rows;
  await (
    await nodePaths(db, workspaceId)
  ).walk(root, after, (row) => {
    rows.push(row);
    return rows.length < limit;
  });
  return rows;
}

/**
 * Up to `limit` rows beneath `root` that are not folders, the folders the walk passed, and whether that was
 * everything. A removal that pages deletes the files and keeps the folders until a page is `whole`: a folder
 * row deleted first would cut what is still beneath it off from its parents, and a built path never reaches it.
 */
export async function removalPage(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  root: string,
  limit: number,
): Promise<{ files: Row[]; folders: Row[]; whole: boolean }> {
  const files: Row[] = [];
  const folders: Row[] = [];
  const whole = await (
    await nodePaths(db, workspaceId)
  ).below(root, (row) => {
    if (row.kind === "folder") folders.push(row);
    else if (files.length === limit) return false;
    else files.push(row);
  });
  return { files, folders, whole };
}

/** Every row beneath `path`, live and gone, each at its path: for a folder small enough to read whole. */
export async function rowsBelow(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string): Promise<Row[]> {
  const rows: Row[] = [];
  await (
    await nodePaths(db, workspaceId)
  ).below(path, (row) => {
    rows.push(row);
  });
  return rows;
}
