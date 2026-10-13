/**
 * The readers moved onto the Convex tree after phase 5: a one-folder listing,
 * the folder picker, link completion, the map and a folder's Lists. Each must
 * answer from the rows exactly what it answers from the bucket, at every
 * clearance, with the rules taken from the tree's mirror.
 *
 * Sabotage:
 *  - drop the delimiter branch in `nodesPagedStore` and the one-level and
 *    picker cases fail (every key comes back as a file, no folder);
 *  - drop `canSee` in `folderNotesFromNodes` and the team List case fails;
 *  - treat a props row at another version as fresh and the "edit the table
 *    missed" case fails;
 *  - drop the queued-move fold in `workspaceGraph` and the moved-link case
 *    fails (the link's source is drawn at a key the map does not hold);
 *  - read link completion from the docmap on a served store and the
 *    "exact now" case fails.
 */

import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { clearanceOf, type Clearance } from "../../functions/lib/clearance";
import { type FileStore, listFolder, setExactVisibility, setFolderVisibility, setVisibility } from "../../functions/lib/fileOps";
import { listFolderPaths } from "../../functions/lib/fileOps/contextMoveExport";
import { notePathIndex } from "../../functions/lib/fileOps/search";
import { workspaceGraph } from "../../functions/lib/fileOps/graph";
import { attachLinkTable, d1LinkTable } from "../../functions/lib/nodes/linkTable";
import { folderNotesFromNodes, folderNotesFromTable, tablePropSource, type PropSource } from "../../functions/lib/filesFns/folderNotes";
import { factPropSource } from "../../functions/lib/nodes/factSources";
import { convexLinkRows } from "../../functions/lib/nodes/linkTable";
import { factCtx, fillAll, observeBucket, tester, workspace as convexWorkspace } from "./facts.helpers";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import {
  foldedPages,
  isServedStore,
  nodesPagedStore,
  servedMoves,
  type NodePage,
} from "../../functions/lib/nodes/manifestStore";
import { privacyMirrorOf } from "../../functions/lib/nodes/privacyMirror";
import { compareKeys } from "../../functions/lib/nodes/sweep";
import type { PendingMove } from "../../functions/lib/nodes/moveOverlay";
import type { NodeRow, PrivacyMirror } from "../../functions/lib/nodes/table";
import { sweepTreePass } from "../../../mcp/src/tree/sweep.js";
import { propFillPass } from "../../../mcp/src/tree/props.js";
import { linkFillPass } from "../../../mcp/src/tree/links.js";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";

// Through `require`: Vite cannot resolve the `node:sqlite` builtin as an import.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function sqliteClient() {
  const db = new DatabaseSync(":memory:");
  return {
    async query(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    },
    async runAll(statements: readonly { sql: string; params?: unknown[] }[]) {
      db.exec("BEGIN");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...(params as never[]));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { applied: statements.length, skipped: false };
    },
  };
}

type Store = MemoryStore & FileStore;
type Client = ReturnType<typeof sqliteClient>;
const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");
const CLEARANCES: Clearance[] = [OWNER, TEAM, clearanceOf("team", ["supa-leads"])];

async function workspace(): Promise<Store> {
  const store = memoryStore() as Store;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/about.md", "---\nstatuses: [todo, doing, done]\n---\n# Projects\n");
  store.seed("1-projects/alpha/overview.md", "---\nstatus: doing\n---\n# Alpha\n\nSee [[task-one]] and [Beta](../beta/overview.md).\n");
  store.seed("1-projects/alpha/task-one.md", "---\nstatus: done\n---\n# Task one\n");
  store.seed("1-projects/beta/overview.md", "---\nstatus: todo\n---\n# Beta\n\nBack to [Alpha](../alpha/overview.md).\n");
  store.seed("1-projects/pay.md", "---\nstatus: secret\n---\n# Pay\n");
  store.seed("1-projects/private/plan.md", "# Plan\n");
  store.seed("1-projects/empty/", "");
  store.seed("1-projects/.hidden/x.md", "---\nstatus: plumbing\n---\n");
  store.seed("1-projectsX/sibling.md", "# Not under 1-projects\n");
  store.seed("2-areas/health/vitals.md", "# Vitals\n");
  store.seed("3-resources/r05.md", "# R5\n");
  store.seed("3-resources/picture.png", "png");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "3-resources", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "1-projects/private", visibility: "private", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: OWNER });
  await setExactVisibility(store, "3-resources/r05.md", "@supa-leads");
  return store;
}

/** The tree's rows for a bucket, as a sweep records them. */
async function rowsOf(store: Store): Promise<NodeRow[]> {
  const listing = await store.list({ limit: 10_000 });
  return (listing.objects ?? [])
    .map((object: { key: string; etag?: string; size?: number; uploaded?: Date }) => ({
      path: object.key,
      ...(object.etag === undefined ? {} : { etag: object.etag }),
      ...(object.size === undefined ? {} : { size: object.size }),
      ...(object.uploaded === undefined ? {} : { uploaded: object.uploaded.getTime() }),
    }))
    .sort((a: NodeRow, b: NodeRow) => compareKeys(a.path, b.path));
}

function pages(rows: readonly NodeRow[], size: number): NodePage {
  return async (after, limit) => {
    const rest = rows.filter((row) => after === undefined || compareKeys(row.path, after) > 0);
    const page = rest.slice(0, Math.min(limit, size));
    return { rows: page, cursor: page.length === Math.min(limit, size) ? page[page.length - 1]!.path : null };
  };
}

async function servedOf(bucket: Store, options: { mirror?: PrivacyMirror | null; moves?: PendingMove[]; rows?: NodeRow[] } = {}) {
  const mirror = options.mirror === undefined ? await privacyMirrorOf(bucket) : options.mirror;
  const listed = pages(options.rows ?? (await rowsOf(bucket)), 3);
  const moves = options.moves ?? [];
  return nodesPagedStore(bucket, moves.length === 0 ? listed : foldedPages(listed, moves), mirror, moves);
}

async function filled(store: Store): Promise<Client> {
  const client = sqliteClient();
  while (!(await sweepTreePass(store, client)).complete);
  for (let pass = 0; pass < 20; pass += 1) if ((await propFillPass(store, client)).ready) break;
  for (let pass = 0; pass < 20; pass += 1) if ((await linkFillPass(store, client)).ready) break;
  return client;
}

describe("a served store says what it is", () => {
  test("the tree's store is marked and carries its moves; the bucket is not", async () => {
    const bucket = await workspace();
    const moves = [{ from: "1-projects/alpha", to: "2-areas/alpha" }];
    const served = await servedOf(bucket, { moves });
    expect(isServedStore(served)).toBe(true);
    expect(servedMoves(served)).toEqual(moves);
    expect(isServedStore(bucket)).toBe(false);
    expect(servedMoves(bucket)).toEqual([]);
    // Nothing that walks the store carries the marks out.
    expect(Object.keys(served)).not.toContain("nodesServed");
  });
});

describe("one folder, and the folder picker", () => {
  test("a one-folder listing from the rows is the bucket's, at every clearance", async () => {
    const bucket = await workspace();
    const served = await servedOf(bucket);
    for (const clearance of CLEARANCES) {
      for (const path of ["", "1-projects", "1-projects/alpha", "1-projects/private", "3-resources", "nowhere"]) {
        const fromTree = await listFolder(served, { path, clearance });
        const fromBucket = await listFolder(bucket, { path, clearance });
        expect(fromTree.entries.map((entry) => entry.path)).toEqual(fromBucket.entries.map((entry) => entry.path));
        expect(fromTree.entries.map((entry) => entry.visibility)).toEqual(fromBucket.entries.map((entry) => entry.visibility));
      }
    }
  });

  test("the picker's folders from the rows are the bucket's, reading the rows once", async () => {
    const bucket = await workspace();
    const rows = await rowsOf(bucket);
    let reads = 0;
    const counted: NodePage = async (after, limit) => {
      reads += 1;
      return await pages(rows, 1_000)(after, limit);
    };
    const served = nodesPagedStore(bucket, counted, await privacyMirrorOf(bucket));
    for (const clearance of CLEARANCES) {
      expect(await listFolderPaths(served, { clearance })).toEqual(await listFolderPaths(bucket, { clearance }));
    }
    // Three clearances, each a picker over every folder, from one read of the rows.
    expect(reads).toBe(1);
  });
});

describe("link completion", () => {
  test("from the rows, exact now, and filtered by the caller's clearance", async () => {
    const bucket = await workspace();
    // No search index at all: the docmap could not answer.
    const served = await servedOf(bucket);
    const owner = await notePathIndex(served, OWNER);
    expect(owner?.paths).toContain("1-projects/pay.md");
    expect(owner?.paths).not.toContain("3-resources/picture.png");
    expect(owner?.paths.some((path) => path.includes("/.hidden/"))).toBe(false);
    const team = await notePathIndex(served, TEAM);
    expect(team?.paths).toContain("1-projects/alpha/overview.md");
    expect(team?.paths).not.toContain("1-projects/pay.md");
    expect(team?.paths).not.toContain("1-projects/private/plan.md");
    expect(team?.paths).not.toContain("3-resources/r05.md");
    // The bucket store still reads the index, which this bucket has none of.
    expect(await notePathIndex(bucket, OWNER)).toBeNull();
  });
});

/** Every page of a List read from the rows, as the app pages it. */
async function allPages(
  served: FileStore,
  client: Client | PropSource,
  operation: { folder: string; subfolders: boolean },
  clearance: Clearance,
): Promise<Awaited<ReturnType<typeof folderNotesFromNodes>>> {
  const notes: Awaited<ReturnType<typeof folderNotesFromNodes>>["notes"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const answer = await folderNotesFromNodes(served, "rows" in client ? client : tablePropSource(client), { ...operation, ...(cursor === undefined ? {} : { cursor }) }, clearance);
    if (!answer.available) return answer;
    notes.push(...answer.notes);
    if (answer.cursor === null) return { ...answer, notes };
    cursor = answer.cursor;
  }
  throw new Error("the List did not end");
}

describe("a folder's List from the rows", () => {
  const byPath = (result: Awaited<ReturnType<typeof folderNotesFromTable>>) =>
    Object.fromEntries(result.notes.map((note) => [note.path, JSON.parse(note.props)]));

  test("says what the table's List says, at owner and team", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const served = await servedOf(bucket);
    for (const clearance of CLEARANCES) {
      for (const subfolders of [true, false]) {
        const operation = { folder: "1-projects", subfolders };
        const fromNodes = await allPages(served, client, operation, clearance);
        const fromTable = await folderNotesFromTable(bucket, client, operation, clearance);
        expect(fromNodes.available).toBe(true);
        expect(byPath(fromNodes)).toEqual(byPath(fromTable));
      }
    }
    const team = byPath(await allPages(served, client, { folder: "1-projects", subfolders: true }, TEAM));
    expect(Object.keys(team)).not.toContain("1-projects/pay.md");
    expect(Object.keys(team)).not.toContain("1-projects/private/plan.md");
  });

  test("a note the table has never seen, or an edit it missed, is read again", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    // Written after the table filled: the rows know it, the table does not.
    bucket.seed("1-projects/gamma.md", "---\nstatus: todo\n---\n# Gamma\n");
    bucket.seed("1-projects/alpha/task-one.md", "---\nstatus: doing\n---\n# Task one\n");
    const served = await servedOf(bucket);
    const notes = byPath(await allPages(served, client, { folder: "1-projects", subfolders: true }, OWNER));
    expect(notes["1-projects/gamma.md"]?.properties).toEqual({ status: "todo" });
    expect(notes["1-projects/alpha/task-one.md"]?.properties).toEqual({ status: "doing" });
  });

  test("the rules are the tree's: a folder the mirror withholds lists as empty", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const mirror = await privacyMirrorOf(bucket);
    const tighter: PrivacyMirror = {
      ...mirror,
      folders: mirror.folders.map((rule) => (rule.prefix.startsWith("1-projects") ? { ...rule, visibility: "private" } : rule)),
    };
    const served = await servedOf(bucket, { mirror: tighter });
    const team = await allPages(served, client, { folder: "1-projects", subfolders: true }, TEAM);
    expect(team.notes).toEqual([]);
  });
});

describe("a folder's List while a folder move is pending", () => {
  /*
   * The rows are drawn at the folder's new name at once; the bucket, and the
   * front matter filed under bucket keys, catch up behind. Before, any
   * pending move anywhere sent every List to the D1 table, at bucket keys
   * judged by the old names' rules: a team folder moved somewhere private
   * kept its notes' front matter, headings and first lines in team members'
   * Lists for as long as the copy ran.
   *
   * Sabotage: look front matter up at the drawn name only and the moved
   * notes come back without their properties (read again at a key the
   * bucket does not hold yet).
   */
  const byPath = (result: Awaited<ReturnType<typeof folderNotesFromNodes>>) =>
    Object.fromEntries(result.notes.map((note) => [note.path, JSON.parse(note.props)]));
  const moves = [{ from: "1-projects/alpha", to: "2-areas/alpha" }];

  test("lists the moving notes at their new name, with the front matter filed at the old one", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const served = await servedOf(bucket, { moves });
    const owner = await allPages(served, client, { folder: "2-areas/alpha", subfolders: true }, OWNER);
    expect(owner.available).toBe(true);
    const notes = byPath(owner);
    expect(Object.keys(notes).sort()).toEqual(["2-areas/alpha/overview.md", "2-areas/alpha/task-one.md"]);
    expect(notes["2-areas/alpha/overview.md"]?.properties).toEqual({ status: "doing" });
    expect(notes["2-areas/alpha/task-one.md"]?.properties).toEqual({ status: "done" });
  });

  test("a team member's List of the old folder no longer holds what moved somewhere private", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const served = await servedOf(bucket, { moves });
    const team = byPath(await allPages(served, client, { folder: "1-projects", subfolders: true }, TEAM));
    expect(Object.keys(team).some((path) => path.includes("alpha"))).toBe(false);
    expect(Object.keys(team)).toContain("1-projects/beta/overview.md");
    const there = await allPages(served, client, { folder: "2-areas", subfolders: true }, TEAM);
    expect(there.notes).toEqual([]);
  });
});

describe("a folder's List from the Convex facts", () => {
  const byPath = (result: Awaited<ReturnType<typeof folderNotesFromTable>>) =>
    Object.fromEntries(result.notes.map((note) => [note.path, JSON.parse(note.props)]));

  async function withFacts(bucket: Store) {
    const t = tester();
    const ws = await convexWorkspace(t, "lists");
    await observeBucket(t, ws, bucket);
    await fillAll(t, ws, bucket);
    return { t, ws, source: factPropSource(factCtx(t).ctx, ws) };
  }

  test("says what the table's List says, at every clearance", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const { source } = await withFacts(bucket);
    const served = await servedOf(bucket);
    for (const clearance of CLEARANCES) {
      for (const subfolders of [true, false]) {
        const operation = { folder: "1-projects", subfolders };
        const fromFacts = await allPages(served, source, operation, clearance);
        expect(fromFacts.available).toBe(true);
        expect(byPath(fromFacts)).toEqual(byPath(await allPages(served, client, operation, clearance)));
      }
    }
    const team = byPath(await allPages(served, source, { folder: "1-projects", subfolders: true }, TEAM));
    expect(Object.keys(team)).not.toContain("1-projects/pay.md");
  });

  test("an edit the facts have not read yet is read again from the bucket, never served stale", async () => {
    const bucket = await workspace();
    const { source } = await withFacts(bucket);
    await bucket.put("1-projects/alpha/task-one.md", "---\nstatus: doing\n---\n# Task one\n");
    const served = await servedOf(bucket);
    const notes = byPath(await allPages(served, source, { folder: "1-projects", subfolders: true }, OWNER));
    expect(notes["1-projects/alpha/task-one.md"]?.properties).toEqual({ status: "doing" });
  });
});

describe("the map from the rows", () => {
  test("the Convex facts' links draw what the table's draw, at every clearance, a moving folder too", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const t = tester();
    const ws = await convexWorkspace(t, "map");
    await observeBucket(t, ws, bucket);
    await fillAll(t, ws, bucket);
    const { ctx } = factCtx(t);
    const named = (graph: Awaited<ReturnType<typeof workspaceGraph>>) => ({
      nodes: graph.nodes.map((node) => node.path),
      edges: graph.edges.map(([from, to]) => `${graph.nodes[from]!.path} > ${graph.nodes[to]!.path}`).sort(),
    });
    for (const moves of [[], [{ from: "1-projects/alpha", to: "2-areas/alpha" }]]) {
      for (const clearance of CLEARANCES) {
        const fromTable = attachLinkTable(await servedOf(bucket, { moves }), d1LinkTable(client, 0));
        const fromFacts = attachLinkTable(await servedOf(bucket, { moves }), {
          unparsed: 0,
          read: async () => ({ paths: (await rowsOf(bucket)).map((row) => row.path).filter((path) => path.endsWith(".md")), links: await convexLinkRows(ctx, ws) }),
        });
        const drawn = named(await workspaceGraph(fromFacts, clearance));
        expect(drawn).toEqual(named(await workspaceGraph(fromTable, clearance)));
        if (clearance === OWNER) expect(drawn.edges.length).toBeGreaterThan(0);
      }
    }
  });

  test("draws a moving folder at its new name, links included, before a byte is copied", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const moves = [{ from: "1-projects/alpha", to: "2-areas/alpha" }];
    const served = await servedOf(bucket, { moves });
    attachLinkTable(served, d1LinkTable(client, 0));
    const graph = await workspaceGraph(served, OWNER);
    const paths = graph.nodes.map((node) => node.path);
    expect(paths).toContain("2-areas/alpha/overview.md");
    expect(paths).not.toContain("1-projects/alpha/overview.md");
    const named = graph.edges.map(([from, to]) => `${paths[from]} > ${paths[to]}`);
    // The link out of the moved note, and the link into it, both follow it.
    expect(named).toContain("2-areas/alpha/overview.md > 1-projects/beta/overview.md");
    expect(named).toContain("1-projects/beta/overview.md > 2-areas/alpha/overview.md");
  });

  test("a note the link table has not met yet is still drawn, from the rows", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    bucket.seed("1-projects/gamma.md", "# Gamma\n");
    const served = await servedOf(bucket);
    attachLinkTable(served, d1LinkTable(client, 1));
    const team = await workspaceGraph(served, TEAM);
    const paths = team.nodes.map((node) => node.path);
    expect(paths).toContain("1-projects/gamma.md");
    expect(paths).not.toContain("1-projects/pay.md");
  });
});
