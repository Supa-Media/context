/**
 * The parity check, end to end: a tree swept from a bucket, then compared with
 * it at every clearance. The check has to fail when the tree is wrong (each
 * kind of sabotage below is caught on its own), or it proves nothing when it
 * passes.
 *
 * The workspace and paging helpers match `sweepTouch.test.ts`: the sweep runs
 * through a store that answers seven keys a page, so the comparison is made
 * over a tree that was built across several passes.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { type FileStore } from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { checkParity } from "../../functions/lib/nodes/parity";
import { sweepNodesPass, type NodeListingStore } from "../../functions/lib/nodes/sweep";
import { touchNodes } from "../../functions/lib/nodes/touch";
import type { NodeRow, NodeSink } from "../../functions/lib/nodes/table";
import { memoryNodeSink } from "../nodeTable.helpers";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { renderPrivacyManifest, setExactVisibility, setFolderVisibility, setVisibility } from "../seededRules.helpers";

type Store = MemoryStore & FileStore;
const OWNER = clearanceOf("private");

/** The treeTable workspace, with one team note inside a team folder held to a group. */
async function workspace(): Promise<Store> {
  const store = memoryStore() as Store;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/launch.md", "# Launch\n");
  store.seed("1-projects/launch/brief.md", "# Brief\n");
  store.seed("1-projects/held-back.md", "# Held back\n");
  store.seed("1-projects/private/plan.md", "# Plan\n");
  store.seed("1-projectsX/sibling.md", "# Not under 1-projects\n");
  store.seed("2-areas/health/vitals.md", "# Vitals\n");
  store.seed(".context/reads/2026-10-08/1.json", "{}");
  for (let index = 0; index < 30; index += 1) {
    store.seed(`3-resources/r${String(index).padStart(2, "0")}.md`, `# R${index}\n`);
  }
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "3-resources", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "1-projects/private", visibility: "private", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/held-back.md", visibility: "private", clearance: OWNER });
  await setExactVisibility(store, "3-resources/r05.md", "@supa-leads");
  return store;
}

function ticker(start = 1_000): () => number {
  let at = start;
  return () => (at += 1);
}

function pagedStore(base: Store, size: number): NodeListingStore {
  return {
    list: (options) => base.list({ ...options, limit: Math.min(options?.limit ?? 1_000, size) }),
    get: (key) => base.get(key),
  };
}

async function sweepToEnd(store: Store, sink: NodeSink, now = ticker()): Promise<void> {
  for (let pass = 1; pass <= 50; pass += 1) {
    const result = await sweepNodesPass(pagedStore(store, 7), sink, { now, maxPages: 2 });
    if (result.complete) return;
  }
  throw new Error("the sweep did not finish");
}

/** The tree's live file rows, as the parity check is handed them. */
function liveRows(sink: ReturnType<typeof memoryNodeSink>): NodeRow[] {
  return sink.table
    .rows()
    .filter((node) => node.kind === "file" && node.goneAt === undefined)
    .map((node) => ({ path: node.path, etag: node.etag, size: node.size, uploaded: node.uploaded }));
}

/** A swept tree of the workspace, ready to be compared or sabotaged. */
async function sweptTree() {
  const store = await workspace();
  const sink = memoryNodeSink();
  await sweepToEnd(store, sink);
  return { store, sink };
}

describe("parity between the tree and the bucket", () => {
  test("a swept tree equals the bucket at the owner, team, and each group clearance", async () => {
    const { store, sink } = await sweptTree();
    const result = await checkParity(store, liveRows(sink), await sink.privacy());
    expect(result).toEqual({ clearances: 3, mismatches: 0, privacyMatches: true });
  });

  test("a private note the tree has dropped is a mismatch, and only at the owner's clearance", async () => {
    const { store, sink } = await sweptTree();
    const row = await sink.table.byPath("1-projects/held-back.md");
    await sink.table.remove(row!.id);
    const result = await checkParity(store, liveRows(sink), await sink.privacy());
    expect(result.mismatches).toBe(1);
    expect(result.privacyMatches).toBe(true);
  });

  test("a row whose etag the bucket does not hold is a mismatch at every clearance that can see it", async () => {
    const { store, sink } = await sweptTree();
    const row = await sink.table.byPath("3-resources/r00.md");
    await sink.table.patch(row!.id, { etag: "tampered" });
    const result = await checkParity(store, liveRows(sink), await sink.privacy());
    expect(result.mismatches).toBe(3);
  });

  test("a row the bucket lacks is a mismatch at every clearance that can see it", async () => {
    const { store, sink } = await sweptTree();
    await sink.table.insert({
      path: "3-resources/ghost.md",
      name: "ghost.md",
      kind: "file",
      etag: "ghost",
      size: 1,
      observedAt: 1,
    });
    const result = await checkParity(store, liveRows(sink), await sink.privacy());
    expect(result.mismatches).toBe(3);
  });

  test("a privacy mirror that lost a folder rule is not the bucket's rules", async () => {
    const { store, sink } = await sweptTree();
    const mirror = (await sink.privacy())!;
    const lost = { ...mirror, folders: mirror.folders.filter((folder) => folder.prefix !== "3-resources") };
    const result = await checkParity(store, liveRows(sink), lost);
    expect(result.privacyMatches).toBe(false);
  });

  test("a folder visibility changed in the bucket breaks parity until privacy.md is touched", async () => {
    const { store, sink } = await sweptTree();
    const now = ticker(5_000);
    await setFolderVisibility(store, { path: "3-resources", visibility: "private", clearance: OWNER });
    const stale = await checkParity(store, liveRows(sink), await sink.privacy());
    expect(stale.privacyMatches).toBe(false);
    expect(stale.mismatches).toBeGreaterThan(0);

    await touchNodes(store, sink, { files: [PRIVACY_KEY], now });
    const fresh = await checkParity(store, liveRows(sink), await sink.privacy());
    expect(fresh).toEqual({ clearances: 3, mismatches: 0, privacyMatches: true });
  });

  test("a bucket with no privacy file is at parity with a tree that has no mirror", async () => {
    const store = memoryStore() as Store;
    store.seed("index.md", "# Context\n");
    store.seed("1-projects/a.md", "# A\n");
    const sink = memoryNodeSink();
    await sweepToEnd(store, sink);
    expect(await sink.privacy()).toBeNull();
    const result = await checkParity(store, liveRows(sink), null);
    expect(result).toEqual({ clearances: 2, mismatches: 0, privacyMatches: true });
  });
});

describe("a folder marker key", () => {
  test("is its own row, so an otherwise empty folder matches the bucket, and leaves when the marker does", async () => {
    const store = await workspace();
    // What an S3 console's "Create folder" writes: a zero-byte key ending in "/".
    store.seed("1-projects/empty/", "");
    const sink = memoryNodeSink();
    await sweepToEnd(store, sink);
    expect(liveRows(sink).map((row) => row.path)).toContain("1-projects/empty/");
    expect((await checkParity(store, liveRows(sink), await sink.privacy())).mismatches).toBe(0);

    await store.delete("1-projects/empty/");
    await touchNodes(store, sink, { paths: ["1-projects/empty"], now: ticker(10_000) });
    expect(liveRows(sink).map((row) => row.path)).not.toContain("1-projects/empty/");
    expect((await checkParity(store, liveRows(sink), await sink.privacy())).mismatches).toBe(0);
  });
});
