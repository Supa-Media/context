/**
 * `workspaceGraph` (`lib/fileOps/graph.ts`) — the console map's notes and
 * links, read from the search index per shard and filtered per caller.
 *
 * What is asserted, and why:
 *
 *  - **Absent is not empty.** A bucket nothing has indexed answers
 *    `indexMissing`, never a silent empty map.
 *  - **Edges come from the index's own resolved links**, deduplicated, never a
 *    self-link, with a bare `[[name]]` falling back to a unique file-name
 *    match among visible notes and an ambiguous one left undrawn.
 *  - **A hidden note is invisible through every field.** A team caller sees
 *    neither the private note nor any edge into or out of it, and — the
 *    stronger property — the whole answer is byte-identical whether or not
 *    the hidden note exists at all, so counts and edges cannot be used to
 *    infer it.
 *  - **Caps are honest** and a shard that cannot be read says `behind` only to
 *    a caller who had something in it to see.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  type FileStore,
  maintainSearchIndex,
  setFolderVisibility,
  setVisibility,
} from "../functions/lib/fileOps";
import { workspaceGraph } from "../functions/lib/fileOps/graph";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { shardKey } from "../../mcp/src/search/shards.js";

type Bucket = MemoryStore & FileStore;

function bucket(withHidden = true): Bucket {
  const store = memoryStore() as Bucket;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n\nSee [[1-projects/plan]].\n");
  store.seed(
    "1-projects/plan.md",
    "# Plan\n\nBudget in [[pay]], notes in [[notes]], [again](notes.md), self [[plan]].\n",
  );
  store.seed("1-projects/notes.md", "# Notes\n\nBack to [[plan]].\n");
  if (withHidden) {
    store.seed("1-projects/pay.md", "# Pay\n\nConfidential. Ties to [[plan]] and [[notes]].\n");
  }
  store.seed("2-areas/area.md", "# Area\n\nSee [[plan]] and [[dup]].\n");
  store.seed("2-areas/a/dup.md", "# Dup A\n");
  store.seed("2-areas/b/dup.md", "# Dup B\n");
  return store;
}

async function shareProjects(store: FileStore, withHidden = true): Promise<void> {
  const owner = clearanceOf("private");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: owner });
  if (withHidden) {
    await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: owner });
  }
}

async function indexed(store: FileStore): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    if ((await maintainSearchIndex(store)).complete) break;
  }
}

function edgePaths(graph: Awaited<ReturnType<typeof workspaceGraph>>): string[] {
  return graph.edges.map(([from, to]) => `${graph.nodes[from].path} -> ${graph.nodes[to].path}`).sort();
}

describe("workspaceGraph", () => {
  test("a bucket with no index answers indexMissing, never an empty workspace", async () => {
    const graph = await workspaceGraph(bucket(), clearanceOf("private"));
    expect(graph).toEqual({ nodes: [], edges: [], truncated: false, behind: true, indexMissing: true });
  });

  test("the owner sees every note, titled by file name, and every resolved link once", async () => {
    const store = bucket();
    await indexed(store);
    const graph = await workspaceGraph(store, clearanceOf("private"));

    expect(graph.indexMissing).toBe(false);
    expect(graph.behind).toBe(false);
    expect(graph.truncated).toBe(false);
    expect(graph.nodes).toEqual([
      { path: "1-projects/notes.md", title: "notes" },
      { path: "1-projects/pay.md", title: "pay" },
      { path: "1-projects/plan.md", title: "plan" },
      { path: "2-areas/a/dup.md", title: "dup" },
      { path: "2-areas/area.md", title: "area" },
      { path: "2-areas/b/dup.md", title: "dup" },
      { path: "index.md", title: "index" },
    ]);
    expect(edgePaths(graph)).toEqual([
      "1-projects/notes.md -> 1-projects/plan.md",
      "1-projects/pay.md -> 1-projects/notes.md",
      "1-projects/pay.md -> 1-projects/plan.md",
      // `[[notes]]` and `[again](notes.md)` are one edge; `[[plan]]` on plan
      // itself is no edge.
      "1-projects/plan.md -> 1-projects/notes.md",
      "1-projects/plan.md -> 1-projects/pay.md",
      // `[[plan]]` from 2-areas resolves to `2-areas/plan.md`, which is not a
      // note; the unique `plan.md` is. `[[dup]]` names two notes: not drawn.
      "2-areas/area.md -> 1-projects/plan.md",
      "index.md -> 1-projects/plan.md",
    ]);
    // Sorted, unique, no self-links.
    const keys = graph.edges.map(([a, b]) => `${a},${b}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(graph.edges.every(([a, b]) => a !== b)).toBe(true);
  });

  test("a team caller sees neither the private note nor any edge into or out of it", async () => {
    const store = bucket();
    await shareProjects(store);
    await indexed(store);

    const asOwner = await workspaceGraph(store, clearanceOf("private"));
    expect(asOwner.nodes.map((node) => node.path)).toContain("1-projects/pay.md");

    const asTeam = await workspaceGraph(store, clearanceOf("team"));
    expect(asTeam.nodes.map((node) => node.path)).toEqual([
      "1-projects/notes.md",
      "1-projects/plan.md",
    ]);
    expect(edgePaths(asTeam)).toEqual([
      "1-projects/notes.md -> 1-projects/plan.md",
      "1-projects/plan.md -> 1-projects/notes.md",
    ]);
    // Not anywhere in the answer, in any field.
    expect(JSON.stringify(asTeam)).not.toContain("pay");
    // The private 2-areas notes are absent too: team sees only what was shared.
    expect(JSON.stringify(asTeam)).not.toContain("2-areas");
  });

  test("the team answer is identical whether or not the hidden note exists", async () => {
    // The inference attack: compare counts, edges, flags. With the hidden
    // note linking to and from visible ones, and a visible note linking to
    // it by bare name, nothing in the answer may move.
    //
    // A visible `sub/pay.md` makes the bare-name fallback part of the attack:
    // `[[pay]]` from plan resolves to the hidden note's path, and if the
    // fallback weighed hidden names too it would call `pay.md` ambiguous only
    // when the hidden note exists.
    const withHidden = bucket(true);
    withHidden.seed("1-projects/sub/pay.md", "# Visible pay\n");
    await shareProjects(withHidden, true);
    await indexed(withHidden);
    const without = bucket(false);
    without.seed("1-projects/sub/pay.md", "# Visible pay\n");
    await shareProjects(without, false);
    await indexed(without);

    const a = await workspaceGraph(withHidden, clearanceOf("team"));
    const b = await workspaceGraph(without, clearanceOf("team"));
    expect(a).toEqual(b);
    // And the fallback did draw, so the comparison is not of two empty maps.
    expect(edgePaths(a)).toContain("1-projects/plan.md -> 1-projects/sub/pay.md");
  });

  test("the node cap truncates, and no edge points past the nodes kept", async () => {
    const store = bucket();
    await indexed(store);
    const graph = await workspaceGraph(store, clearanceOf("private"), { nodeCap: 3 });
    expect(graph.truncated).toBe(true);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges.every(([a, b]) => a < 3 && b < 3)).toBe(true);
  });

  test("the edge cap truncates", async () => {
    const store = bucket();
    await indexed(store);
    const graph = await workspaceGraph(store, clearanceOf("private"), { edgeCap: 2 });
    expect(graph.truncated).toBe(true);
    expect(graph.edges).toHaveLength(2);
  });

  test("an unreadable shard is `behind` only for a caller with something in it", async () => {
    const store = bucket();
    // Nothing shared: a team caller has no node anywhere.
    await indexed(store);
    store.seed(shardKey(0), "{ not json");

    const owner = await workspaceGraph(store, clearanceOf("private"));
    expect(owner.behind).toBe(true);
    expect(owner.edges).toEqual([]);

    const team = await workspaceGraph(store, clearanceOf("team"));
    expect(team).toEqual({ nodes: [], edges: [], truncated: false, behind: false, indexMissing: false });
  });
});
