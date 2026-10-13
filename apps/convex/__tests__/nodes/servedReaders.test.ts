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
 *  - treat a props row at another version as fresh and the "edit the facts
 *    missed" case fails;
 *  - drop the queued-move fold in `workspaceGraph` and the moved-link case
 *    fails (the link's source is drawn at a key the map does not hold);
 *  - read link completion from the docmap on a served store and the
 *    "exact now" case fails.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf, type Clearance } from "../../functions/lib/clearance";
import { type FileStore, listFolder, setExactVisibility, setFolderVisibility, setVisibility } from "../../functions/lib/fileOps";
import { listFolderPaths } from "../../functions/lib/fileOps/contextMoveExport";
import { notePathIndex } from "../../functions/lib/fileOps/search";
import { workspaceGraph } from "../../functions/lib/fileOps/graph";
import { attachLinkTable, convexLinkRows, type LinkTable } from "../../functions/lib/nodes/linkTable";
import { folderNotesFromNodes, STALE_READ_CAP, type PropSource } from "../../functions/lib/filesFns/folderNotes";
import { factPropSource } from "../../functions/lib/nodes/factSources";
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
import { memoryStore, type MemoryStore } from "../storeStub.helpers";

type Store = MemoryStore & FileStore;
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

async function servedOf(
  bucket: Store,
  options: { mirror?: PrivacyMirror | null; moves?: PendingMove[]; rows?: NodeRow[]; pageSize?: number } = {},
) {
  const mirror = options.mirror === undefined ? await privacyMirrorOf(bucket) : options.mirror;
  const listed = pages(options.rows ?? (await rowsOf(bucket)), options.pageSize ?? 3);
  const moves = options.moves ?? [];
  return nodesPagedStore(bucket, moves.length === 0 ? listed : foldedPages(listed, moves), mirror, moves);
}

/** The Convex tree mirroring `bucket`, its facts filled: what a List and the map read. */
async function withFacts(bucket: Store) {
  const t = tester();
  const ws = await convexWorkspace(t, "readers");
  await observeBucket(t, ws, bucket);
  await fillAll(t, ws, bucket);
  const { ctx } = factCtx(t);
  return { source: factPropSource(ctx, ws), links: () => convexLinkRows(ctx, ws) };
}

/**
 * Props from nowhere: every note is stale, so a List reads each from the
 * bucket. What the facts must answer, without the reads.
 */
const BUCKET_READS: PropSource = { rows: async () => new Map() };

/** The facts' links as the map's table, over the bucket's notes as they are now. */
function factsTable(bucket: Store, links: () => Promise<string[][]>, unparsed = 0): LinkTable {
  return {
    unparsed,
    read: async () => ({
      paths: (await rowsOf(bucket)).map((row) => row.path).filter((path) => path.endsWith(".md")),
      links: await links(),
    }),
  };
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
  source: PropSource,
  operation: { folder: string; subfolders: boolean },
  clearance: Clearance,
): Promise<Awaited<ReturnType<typeof folderNotesFromNodes>>> {
  const notes: Awaited<ReturnType<typeof folderNotesFromNodes>>["notes"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const answer = await folderNotesFromNodes(served, source, { ...operation, ...(cursor === undefined ? {} : { cursor }) }, clearance);
    if (!answer.available) return answer;
    notes.push(...answer.notes);
    if (answer.cursor === null) return { ...answer, notes };
    cursor = answer.cursor;
  }
  throw new Error("the List did not end");
}

describe("a folder's List from the Convex facts", () => {
  const byPath = (result: Awaited<ReturnType<typeof folderNotesFromNodes>>) =>
    Object.fromEntries(result.notes.map((note) => [note.path, JSON.parse(note.props)]));

  test("says what reading every note from the bucket says, at every clearance", async () => {
    const bucket = await workspace();
    const { source } = await withFacts(bucket);
    const served = await servedOf(bucket);
    for (const clearance of CLEARANCES) {
      for (const subfolders of [true, false]) {
        const operation = { folder: "1-projects", subfolders };
        const fromFacts = await allPages(served, source, operation, clearance);
        expect(fromFacts.available).toBe(true);
        expect(byPath(fromFacts)).toEqual(byPath(await allPages(served, BUCKET_READS, operation, clearance)));
      }
    }
    const owner = byPath(await allPages(served, source, { folder: "1-projects", subfolders: true }, OWNER));
    expect(owner["1-projects/alpha/overview.md"]?.properties).toEqual({ status: "doing" });
    const team = byPath(await allPages(served, source, { folder: "1-projects", subfolders: true }, TEAM));
    expect(Object.keys(team)).not.toContain("1-projects/pay.md");
    expect(Object.keys(team)).not.toContain("1-projects/private/plan.md");
  });

  test("a note the facts have never seen, or an edit they missed, is read again, never served stale", async () => {
    const bucket = await workspace();
    const { source } = await withFacts(bucket);
    // Written after the facts filled: the rows know them, the facts do not.
    bucket.seed("1-projects/gamma.md", "---\nstatus: todo\n---\n# Gamma\n");
    await bucket.put("1-projects/alpha/task-one.md", "---\nstatus: doing\n---\n# Task one\n");
    const served = await servedOf(bucket);
    const notes = byPath(await allPages(served, source, { folder: "1-projects", subfolders: true }, OWNER));
    expect(notes["1-projects/gamma.md"]?.properties).toEqual({ status: "todo" });
    expect(notes["1-projects/alpha/task-one.md"]?.properties).toEqual({ status: "doing" });
  });

  test("without subfolders, only the folder's own notes; never plumbing, attachments or encrypted notes", async () => {
    const bucket = await workspace();
    bucket.seed("1-projects/locked.md", "---\ncontext_encryption: v1\n---\n\nciphertext\n");
    bucket.seed("1-projects/picture.png", "png");
    const { source } = await withFacts(bucket);
    const served = await servedOf(bucket);
    const own = byPath(await allPages(served, source, { folder: "1-projects", subfolders: false }, OWNER));
    expect(Object.keys(own).sort()).toEqual(["1-projects/about.md", "1-projects/pay.md"]);
    const every = Object.keys(byPath(await allPages(served, source, { folder: "1-projects", subfolders: true }, OWNER)));
    expect(every.some((path) => path.includes("/.hidden/") || path.endsWith(".png") || path.endsWith("locked.md"))).toBe(false);
  });

  test("more notes the facts have not read than one page may re-read hands the List back to the bucket", async () => {
    const bucket = await workspace();
    const { source } = await withFacts(bucket);
    for (let index = 0; index <= STALE_READ_CAP; index += 1) bucket.seed(`1-projects/many/n${index}.md`, "# n\n");
    const answer = await folderNotesFromNodes(await servedOf(bucket, { pageSize: 10_000 }), source, { folder: "1-projects", subfolders: true }, OWNER);
    expect(answer).toMatchObject({ available: false, fill: true });
  });

  test("the rules are the tree's: a folder the mirror withholds lists as empty", async () => {
    const bucket = await workspace();
    const { source } = await withFacts(bucket);
    const mirror = await privacyMirrorOf(bucket);
    const tighter: PrivacyMirror = {
      ...mirror,
      folders: mirror.folders.map((rule) => (rule.prefix.startsWith("1-projects") ? { ...rule, visibility: "private" } : rule)),
    };
    const served = await servedOf(bucket, { mirror: tighter });
    const team = await allPages(served, source, { folder: "1-projects", subfolders: true }, TEAM);
    expect(team.notes).toEqual([]);
  });
});

describe("the map from the rows", () => {
  const named = (graph: Awaited<ReturnType<typeof workspaceGraph>>) => ({
    nodes: graph.nodes.map((node) => node.path),
    edges: graph.edges.map(([from, to]) => `${graph.nodes[from]!.path} > ${graph.nodes[to]!.path}`).sort(),
  });

  test("the Convex facts' links draw what the notes say, at every clearance", async () => {
    const bucket = await workspace();
    const { links } = await withFacts(bucket);
    const edges = [
      "1-projects/alpha/overview.md > 1-projects/alpha/task-one.md",
      "1-projects/alpha/overview.md > 1-projects/beta/overview.md",
      "1-projects/beta/overview.md > 1-projects/alpha/overview.md",
    ];
    for (const clearance of CLEARANCES) {
      const drawn = named(await workspaceGraph(attachLinkTable(await servedOf(bucket), factsTable(bucket, links)), clearance));
      expect(drawn.edges).toEqual(edges);
      expect(drawn.nodes.includes("1-projects/pay.md")).toBe(clearance === OWNER);
      expect(drawn.nodes.includes("3-resources/r05.md")).toBe(clearance !== TEAM);
    }
  });

  test("draws a moving folder at its new name, links included, before a byte is copied", async () => {
    const bucket = await workspace();
    const { links } = await withFacts(bucket);
    const moves = [{ from: "1-projects/alpha", to: "2-areas/alpha" }];
    const graph = await workspaceGraph(attachLinkTable(await servedOf(bucket, { moves }), factsTable(bucket, links)), OWNER);
    const { nodes, edges } = named(graph);
    expect(nodes).toContain("2-areas/alpha/overview.md");
    expect(nodes).not.toContain("1-projects/alpha/overview.md");
    // The link out of the moved note, and the link into it, both follow it.
    expect(edges).toContain("2-areas/alpha/overview.md > 1-projects/beta/overview.md");
    expect(edges).toContain("1-projects/beta/overview.md > 2-areas/alpha/overview.md");
    expect(edges).toContain("2-areas/alpha/overview.md > 2-areas/alpha/task-one.md");
  });

  test("a note the link table has not met yet is still drawn, from the rows", async () => {
    const bucket = await workspace();
    const { links } = await withFacts(bucket);
    bucket.seed("1-projects/gamma.md", "# Gamma\n");
    const served = attachLinkTable(await servedOf(bucket), factsTable(bucket, links, 1));
    const team = await workspaceGraph(served, TEAM);
    const paths = team.nodes.map((node) => node.path);
    expect(paths).toContain("1-projects/gamma.md");
    expect(paths).not.toContain("1-projects/pay.md");
  });
});
