/**
 * The map drawn from the tree's link table is the map the search index draws,
 * without reading the index.
 *
 * Once every note's links have been read into the table beside the tree
 * (`apps/mcp/src/tree/links.js`), the barrier hands `workspaceGraph` the
 * table (`linkTable` on the store) and the notes and links come from two
 * queries instead of every shard. The privacy property does not move: a note
 * is drawn only if `canSee` passes, a link only if both ends are drawn, and a
 * bare name resolves only among drawn notes. So the assertion is equality
 * with the index's answer, at owner and team clearance, with a note held back
 * by name — and that the index is not read at all.
 */

import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, maintainSearchIndex, setFolderVisibility, setVisibility } from "../functions/lib/fileOps";
import { LINKS_BEHIND_MIN, LINKS_BEHIND_SHARE, linksBehind, workspaceGraph } from "../functions/lib/fileOps/graph";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { sweepTreePass } from "../../mcp/src/tree/sweep.js";
import { linkFillPass } from "../../mcp/src/tree/links.js";
import { DOCMAP_KEY } from "../../mcp/src/search/shards/constants.js";

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

type Bucket = MemoryStore & FileStore;
const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");

async function workspace(): Promise<Bucket> {
  const store = memoryStore() as Bucket;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("1-projects/plan.md", "# Plan\n\nBudget in [[pay]], notes in [[notes]].\n");
  store.seed("1-projects/notes.md", "# Notes\n\nBack to [[plan]] and [the area](../2-areas/area.md).\n");
  store.seed("1-projects/sub/pay.md", "# Visible pay\n");
  store.seed("1-projects/pay.md", "# Pay\n\nTies to [[plan]] and [[notes]].\n");
  store.seed("2-areas/area.md", "# Area\n\nSee [[plan]].\n");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: OWNER });
  for (let pass = 0; pass < 400; pass += 1) {
    if ((await maintainSearchIndex(store)).complete) return store;
  }
  throw new Error("the index never converged");
}

async function withTable(store: Bucket): Promise<Bucket> {
  const client = sqliteClient();
  while (!(await sweepTreePass(store, client)).complete);
  for (let pass = 0; pass < 20; pass += 1) if ((await linkFillPass(store, client)).ready) break;
  Object.defineProperty(store, "linkTable", { value: { client, unparsed: 0 }, enumerable: false, configurable: true });
  return store;
}

function named(graph: Awaited<ReturnType<typeof workspaceGraph>>) {
  return {
    nodes: graph.nodes.map((node) => node.path),
    edges: graph.edges.map(([from, to]) => `${graph.nodes[from]!.path} > ${graph.nodes[to]!.path}`).sort(),
  };
}

describe("the map from the link table", () => {
  test.each([
    ["owner", OWNER],
    ["team", TEAM],
  ])("draws what the index draws, at %s clearance, without reading the index", async (_label, clearance) => {
    const store = await workspace();
    const fromIndex = named(await workspaceGraph(store, clearance));
    const table = await withTable(store);
    const reads: string[] = [];
    const get = table.get.bind(table);
    table.get = async (key: string) => {
      reads.push(key);
      return get(key);
    };
    const fromTable = await workspaceGraph(table, clearance);
    expect(named(fromTable)).toEqual(fromIndex);
    expect(fromTable.behind).toBe(false);
    // Neither the docmap nor any shard beside it.
    const searchFolder = DOCMAP_KEY.slice(0, DOCMAP_KEY.lastIndexOf("/") + 1);
    expect(searchFolder.length).toBeGreaterThan(1);
    expect(reads.filter((key) => key.startsWith(searchFolder))).toEqual([]);
  });

  test("a note held back by name is not drawn, and no link to or from it is", async () => {
    const graph = named(await workspaceGraph(await withTable(await workspace()), TEAM));
    expect(graph.nodes).not.toContain("1-projects/pay.md");
    expect(graph.edges.some((edge) => edge.includes("1-projects/pay.md"))).toBe(false);
    // The bare [[pay]] beside plan.md is the hidden note's name: among the
    // notes a team reader may see, it is the one in sub/.
    expect(graph.edges).toContain("1-projects/plan.md > 1-projects/sub/pay.md");
  });

  test("many notes changed since their links were read make the map say it is catching up", async () => {
    const store = await withTable(await workspace());
    const table = (store as unknown as { linkTable: { unparsed: number } }).linkTable;
    table.unparsed = LINKS_BEHIND_MIN;
    expect((await workspaceGraph(store, OWNER)).behind).toBe(true);
  });

  test("a few just-saved notes do not: the next refresh brings their links in", async () => {
    // Every save leaves its note waiting until the next fill pass, so a
    // notice for these would be on almost whenever anybody is writing.
    const store = await withTable(await workspace());
    const table = (store as unknown as { linkTable: { unparsed: number } }).linkTable;
    table.unparsed = 3;
    expect((await workspaceGraph(store, OWNER)).behind).toBe(false);
  });

  test("the bar is a share of a big workspace, and never zero", () => {
    expect(linksBehind(0, 0)).toBe(false);
    expect(linksBehind(LINKS_BEHIND_MIN - 1, 10)).toBe(false);
    expect(linksBehind(LINKS_BEHIND_MIN, 10)).toBe(true);
    // 20,000 notes: 5% is 1,000, so 999 waiting is a normal busy afternoon.
    expect(linksBehind(999, 20_000)).toBe(false);
    expect(linksBehind(20_000 * LINKS_BEHIND_SHARE, 20_000)).toBe(true);
  });
});
