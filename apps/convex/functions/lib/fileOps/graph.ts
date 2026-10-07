/**
 * The console map's graph: every note one caller may see, and the links
 * between them — `docs/decisions/search.md`, "The map's graph is read per
 * shard at request time, and stored nowhere".
 *
 * Built from the search index this bucket already keeps, never from a listing
 * or a body read: the docmap names every note and which shard holds it, and
 * each shard stores, per note, the `.md` targets the indexer resolved out of
 * its text (`extractLinks` in `apps/mcp/src/search/indexer.js`).
 *
 * ## What a caller can and cannot learn here
 *
 * The docmap and the shards hold every note in the bucket, private ones
 * included, regardless of who asks. So everything that leaves this function is
 * decided from the set of notes the caller may see, and from nothing else:
 *
 *  - a node is a path that passes the caller's own `canSee` and is not
 *    plumbing — the same filter `notePathIndex` applies;
 *  - an edge exists only when **both** of its ends are nodes, so a link to or
 *    from a note the caller cannot see is not drawn, not counted, and not
 *    half-drawn to a placeholder;
 *  - a bare `[[name]]` that the indexer resolved to a path that is not a node
 *    falls back to a unique file-name match **among the nodes**. Never among
 *    the docmap: whether the resolved path exists out of sight must not change
 *    the answer, and with the fallback consulting only visible names it does
 *    not — the same answer comes back whether or not the hidden note is there;
 *  - `truncated` compares visible counts to the caps, and `behind` is the
 *    index's own whole-bucket freshness (the same flag search reports) or a
 *    shard that could not be read **and holds a visible note**. A shard that
 *    holds only notes the caller cannot see is never read at all, so its
 *    health cannot reach them either.
 *
 * ## Memory
 *
 * One shard is parsed at a time and only its `path → links` survives the
 * iteration. The PageRank note in `search/CONTRACT.md` is the reason this is
 * not a global graph built at maintenance time: that needs every shard in
 * memory at once, which is exactly what the v2 format exists to avoid.
 */

import { canSee, isPlumbing } from "../privacy";
import type { Clearance } from "../clearance";
import { createSearchBudget } from "../../../../mcp/src/search/maintain.js";
import {
  MAX_SHARD_COUNT,
  decodeShard,
  fetchShardBytes,
  indexIsBehind,
  loadDocmap,
} from "../../../../mcp/src/search/shards.js";
import type { FileStore } from "./store";
import { loadPrivacyState } from "./privacyState";

/** Notes on one map. Past this the canvas is a blur and the answer is a floor. */
export const GRAPH_NODE_CAP = 5_000;

/** Links on one map, for the same reason. */
export const GRAPH_EDGE_CAP = 20_000;

/**
 * Store operations one graph read may spend: the privacy manifest, the
 * manifest, the docmap, and every shard there can be. Nothing else — no
 * listing and no note bodies, ever.
 */
const GRAPH_BUDGET = MAX_SHARD_COUNT + 4;

export interface WorkspaceGraphResult {
  /** Sorted by path. */
  nodes: { path: string; title: string }[];
  /** Index pairs into `nodes`, source first. No self-links, no duplicates. */
  edges: [number, number][];
  /** A cap cut the answer, so it is a floor rather than the whole workspace. */
  truncated: boolean;
  /** The index has not caught up with the bucket: "the map is catching up". */
  behind: boolean;
  /**
   * Nothing has indexed this bucket at all. Distinct from an empty workspace
   * for the reason `notePathIndex` returns `null`: an empty node list here
   * would tell somebody their notes are not there when nothing looked.
   */
  indexMissing: boolean;
}

type ShardDoc = { notePath?: string; links: string[] };
type ParsedShard = { docs: Map<string, ShardDoc> };

/** `1-projects/launch.md` → `launch`. Cheap on purpose: no body read. */
export function titleOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function decoded(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

export async function workspaceGraph(
  store: FileStore,
  clearance: Clearance,
  options: { nodeCap?: number; edgeCap?: number } = {},
): Promise<WorkspaceGraphResult> {
  const nodeCap = options.nodeCap ?? GRAPH_NODE_CAP;
  const edgeCap = options.edgeCap ?? GRAPH_EDGE_CAP;
  const state = await loadPrivacyState(store);
  const isVisible = (path: string) =>
    !isPlumbing(path) &&
    canSee(path, clearance.scope, state.rules, state.overrides, clearance.names);

  const budget = createSearchBudget(GRAPH_BUDGET);
  const found = await loadDocmap(
    store as unknown as Parameters<typeof loadDocmap>[0],
    budget,
    0,
  );
  if (found === null) {
    return { nodes: [], edges: [], truncated: false, behind: true, indexMissing: true };
  }

  const visible = new Set<string>();
  for (const docs of found.docsByShard) {
    for (const path of docs.keys()) if (isVisible(path)) visible.add(path);
  }
  const sorted = [...visible].sort();
  let truncated = sorted.length > nodeCap;
  const nodes = sorted.slice(0, nodeCap).map((path) => ({ path, title: titleOf(path) }));
  const indexOf = new Map(nodes.map((node, position) => [node.path, position]));

  // File name → node, for the bare-wikilink fallback. Built from the nodes and
  // only the nodes — see the header on why that is the privacy property.
  const byName = new Map<string, number | null>();
  for (const [path, position] of indexOf) {
    const name = nameOf(path);
    byName.set(name, byName.has(name) ? null : position);
  }
  const targetOf = (link: string): number | undefined => {
    const direct = indexOf.get(link) ?? indexOf.get(decoded(link));
    if (direct !== undefined) return direct;
    const unique = byName.get(nameOf(decoded(link)));
    return unique === null ? undefined : unique;
  };

  let behind = indexIsBehind(found.manifest.freshness);
  const edges = new Map<string, [number, number]>();
  for (let id = 0; id < found.docsByShard.length; id += 1) {
    let holdsNode = false;
    for (const path of found.docsByShard[id].keys()) {
      if (indexOf.has(path)) {
        holdsNode = true;
        break;
      }
    }
    if (!holdsNode) continue;
    const bytes = await fetchShardBytes(
      store as unknown as Parameters<typeof fetchShardBytes>[0],
      budget,
      0,
      id,
    );
    const shard = (bytes ? decodeShard(bytes) : null) as ParsedShard | null;
    if (shard === null) {
      behind = true;
      continue;
    }
    for (const [key, doc] of shard.docs) {
      const source = indexOf.get(doc.notePath ?? key);
      if (source === undefined) continue;
      for (const link of doc.links) {
        const target = targetOf(link);
        if (target === undefined || target === source) continue;
        const pair = `${source}>${target}`;
        if (edges.has(pair)) continue;
        if (edges.size >= edgeCap) {
          truncated = true;
          continue;
        }
        edges.set(pair, [source, target]);
      }
    }
  }

  return {
    nodes,
    edges: [...edges.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    truncated,
    behind,
    indexMissing: false,
  };
}
