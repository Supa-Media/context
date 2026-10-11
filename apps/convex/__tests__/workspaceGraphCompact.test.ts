/**
 * `workspaceGraph` with `compact: true` — every note the caller may see, for
 * a map that draws all of them (decided by the owner, 2026-10-08), read with
 * several shard fetches in flight rather than one at a time.
 *
 * What is asserted, and why:
 *
 *  - **The compact answer is the same graph.** Decoded, it is exactly the
 *    object answer, so nothing about who sees what changed with the shape.
 *  - **A hidden note still moves nothing**, through the compact answer too.
 *  - **There is no 5,000 floor**, and a workspace bigger than one Convex
 *    array (8,192 items) travels in chunks under it.
 *  - **Shards are fetched in waves**, never more than the search walk's own
 *    concurrency at once, and a shard holding nothing the caller may see is
 *    still never fetched.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, maintainSearchIndex, setFolderVisibility, setVisibility } from "../functions/lib/fileOps";
import { GRAPH_CHUNK, workspaceGraph } from "../functions/lib/fileOps/graph";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { SHARD_READ_CONCURRENCY } from "../../mcp/src/search/shards.js";

type Bucket = MemoryStore & FileStore;

function bucket(withHidden: boolean): Bucket {
  const store = memoryStore() as Bucket;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("1-projects/plan.md", "# Plan\n\nBudget in [[pay]], notes in [[notes]].\n");
  store.seed("1-projects/notes.md", "# Notes\n\nBack to [[plan]].\n");
  store.seed("1-projects/sub/pay.md", "# Visible pay\n");
  if (withHidden) store.seed("1-projects/pay.md", "# Pay\n\nTies to [[plan]] and [[notes]].\n");
  store.seed("2-areas/area.md", "# Area\n\nSee [[plan]].\n");
  return store;
}

async function shareProjects(store: FileStore, withHidden: boolean): Promise<void> {
  const owner = clearanceOf("private");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: owner });
  if (withHidden) await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: owner });
}

async function indexed(store: FileStore): Promise<void> {
  for (let pass = 0; pass < 400; pass += 1) {
    if ((await maintainSearchIndex(store)).complete) return;
  }
  throw new Error("the index never converged");
}

function many(count: number): Bucket {
  const store = memoryStore() as Bucket;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  for (let i = 0; i < count; i += 1) {
    store.seed(`${i % 2 ? "0-inbox" : "2-areas/log"}/n${i}.md`, `# ${i}\n\nSee [[n${(i + 1) % count}]].\n`);
  }
  return store;
}

const decoded = (graph: Awaited<ReturnType<typeof workspaceGraph>>) => ({
  paths: (graph.pathChunks ?? []).flat(),
  links: (graph.linkChunks ?? []).flat(),
});

describe("workspaceGraph, compact", () => {
  test("decodes to exactly the object answer", async () => {
    const store = bucket(true);
    await indexed(store);
    const full = await workspaceGraph(store, clearanceOf("private"));
    const compact = await workspaceGraph(store, clearanceOf("private"), { compact: true });
    expect(compact.nodes).toEqual([]);
    expect(compact.edges).toEqual([]);
    expect(decoded(compact).paths).toEqual(full.nodes.map((node) => node.path));
    expect(decoded(compact).links).toEqual(full.edges.flat());
    expect(full.edges.length).toBeGreaterThan(0);
    const { nodes: _n, edges: _e, pathChunks: _p, linkChunks: _l, ...rest } = compact;
    const { nodes: _fn, edges: _fe, ...fullRest } = full;
    expect(rest).toEqual(fullRest);
  });

  test("a team caller's compact answer is identical whether or not the hidden note exists", async () => {
    const withHidden = bucket(true);
    await shareProjects(withHidden, true);
    await indexed(withHidden);
    const without = bucket(false);
    await shareProjects(without, false);
    await indexed(without);
    const a = await workspaceGraph(withHidden, clearanceOf("team"), { compact: true });
    const b = await workspaceGraph(without, clearanceOf("team"), { compact: true });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain("1-projects/pay.md");
    expect(JSON.stringify(a)).not.toContain("2-areas");
    expect(decoded(a).paths).toContain("1-projects/sub/pay.md");
  });

  test("every note, past the old 5,000 and in chunks under Convex's array limit", async () => {
    const count = GRAPH_CHUNK + 150;
    const store = many(count);
    await indexed(store);
    const old = await workspaceGraph(store, clearanceOf("private"));
    expect(old.nodes).toHaveLength(5_000);
    const graph = await workspaceGraph(store, clearanceOf("private"), { compact: true });
    expect(graph.truncated).toBe(false);
    expect(graph.noteCount).toBe(count);
    expect(decoded(graph).paths).toHaveLength(count);
    expect(graph.pathChunks!.length).toBe(2);
    for (const chunk of [...graph.pathChunks!, ...graph.linkChunks!]) expect(chunk.length).toBeLessThanOrEqual(8_192);
    // Every link resolved, as pairs into the full list.
    expect(decoded(graph).links).toHaveLength(count * 2);
  }, 120_000);

  test("shards are fetched in waves, and a shard with nothing visible is never fetched", async () => {
    const store = many(2_400);
    await indexed(store);
    const realGet = store.get.bind(store);
    let inFlight = 0;
    let most = 0;
    const shardGets: string[] = [];
    store.get = (async (key: string) => {
      if (!key.includes("/shard-")) return await realGet(key);
      shardGets.push(key);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await realGet(key);
      } finally {
        inFlight -= 1;
      }
    }) as typeof store.get;

    const owner = await workspaceGraph(store, clearanceOf("private"), { compact: true });
    expect(owner.noteCount).toBe(2_400);
    expect(shardGets.length).toBeGreaterThan(SHARD_READ_CONCURRENCY);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(SHARD_READ_CONCURRENCY);

    // Nothing is shared: a team caller sees no note, so reads no shard.
    shardGets.length = 0;
    const team = await workspaceGraph(store, clearanceOf("team"), { compact: true });
    expect(team.noteCount).toBe(0);
    expect(shardGets).toEqual([]);
  }, 120_000);
});
