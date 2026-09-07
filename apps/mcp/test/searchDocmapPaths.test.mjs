/**
 * `loadDocmapPaths` (`src/search/shards.js`) — the note-path index link
 * resolution reuses, per `docs/decisions/app-and-console.md` "L1".
 *
 * The function has exactly one job: turn the sharded index's own diff surface
 * into a flat, sorted list of note paths, or `null` when there is nothing
 * trustworthy to answer from. Every check here is a way that second half can
 * go wrong, because a wrong answer here is a link resolved to the wrong note
 * — the one thing worse than a link left unresolved.
 *
 * ## Sabotage record
 *
 *   returning paths for a manifest that failed to load                    1
 *   skipping the manifest read (assuming a shard count)                   1
 *   accepting a docmap whose shardCount disagrees with the manifest's     1
 *   not deduplicating across shards                                      1
 *   not sorting the result                                               1
 *   spending only one budget op instead of two                           2
 */

import {
  DOCMAP_KEY,
  MANIFEST_KEY,
  emptyManifest,
  loadDocmapPaths,
  serializeDocmap,
  serializeManifest,
} from "../src/search/shards.js";
import { createSearchBudget } from "../src/search/maintain.js";

const encoder = new TextEncoder();

/** The minimal store surface `loadDocmapPaths` uses: `get(key)`. */
function createStore(objects) {
  return {
    async get(key) {
      const body = objects[key];
      if (body === undefined) return null;
      return {
        async arrayBuffer() {
          return encoder.encode(body).buffer;
        },
      };
    },
  };
}

function manifestWith(shardCount, docsByShard) {
  const manifest = emptyManifest(shardCount);
  docsByShard.forEach((docs, i) => {
    for (const [path, version] of docs) manifest.docsByShard[i].set(path, version);
  });
  return manifest;
}

export async function runSearchDocmapPathsChecks(check) {
  {
    const manifest = manifestWith(2, [
      [["b.md", "v1"]],
      [
        ["a.md", "v1"],
        ["c.md", "v1"],
      ],
    ]);
    const store = createStore({
      [MANIFEST_KEY]: serializeManifest(manifest),
      [DOCMAP_KEY]: serializeDocmap(manifest),
    });
    const budget = createSearchBudget(10);
    const result = await loadDocmapPaths(store, budget, 0);
    check(
      "docmap paths: flattened across shards and sorted",
      JSON.stringify(result?.paths) === JSON.stringify(["a.md", "b.md", "c.md"]),
    );
    check("docmap paths: costs exactly two budget ops (manifest, docmap)", budget.remaining === 8);
  }

  {
    // A path claimed by more than one shard should not happen in a real
    // index, but a corrupted docmap could say so — the reader must not
    // double-count it.
    const manifest = manifestWith(2, [[["a.md", "v1"]]]);
    manifest.docsByShard[1].set("a.md", "v2");
    const store = createStore({
      [MANIFEST_KEY]: serializeManifest(manifest),
      [DOCMAP_KEY]: serializeDocmap(manifest),
    });
    const result = await loadDocmapPaths(store, createSearchBudget(10), 0);
    check(
      "docmap paths: a path in two shards is not double-counted",
      JSON.stringify(result?.paths) === JSON.stringify(["a.md"]),
    );
  }

  {
    let docmapRead = false;
    const store = {
      async get(key) {
        if (key === DOCMAP_KEY) docmapRead = true;
        return null;
      },
    };
    const result = await loadDocmapPaths(store, createSearchBudget(10), 0);
    check("docmap paths: no manifest -> null", result === null);
    check("docmap paths: no manifest -> the docmap is never read", docmapRead === false);
  }

  {
    const manifest = manifestWith(1, [[["a.md", "v1"]]]);
    const store = createStore({ [MANIFEST_KEY]: serializeManifest(manifest) });
    const result = await loadDocmapPaths(store, createSearchBudget(10), 0);
    check("docmap paths: manifest present, docmap absent -> null", result === null);
  }

  {
    const manifest = manifestWith(2, [[["a.md", "v1"]], [["b.md", "v1"]]]);
    const store = createStore({
      [MANIFEST_KEY]: serializeManifest(manifest),
      [DOCMAP_KEY]: serializeDocmap(emptyManifest(3)), // 3 shards vs. manifest's 2
    });
    const result = await loadDocmapPaths(store, createSearchBudget(10), 0);
    check("docmap paths: a docmap for a different shard count -> null, not a partial answer", result === null);
  }

  {
    const manifest = manifestWith(1, [[["a.md", "v1"]]]);
    const store = createStore({
      [MANIFEST_KEY]: serializeManifest(manifest),
      [DOCMAP_KEY]: "{ not json",
    });
    const result = await loadDocmapPaths(store, createSearchBudget(10), 0);
    check("docmap paths: corrupt docmap JSON -> null", result === null);
  }

  {
    const manifest = manifestWith(1, [[["a.md", "v1"]]]);
    const store = createStore({
      [MANIFEST_KEY]: serializeManifest(manifest),
      [DOCMAP_KEY]: serializeDocmap(manifest),
    });
    const result = await loadDocmapPaths(store, createSearchBudget(0), 0);
    check("docmap paths: an empty budget refuses before either read", result === null);
  }

  {
    const manifest = manifestWith(1, [[["a.md", "v1"]]]);
    const store = createStore({
      [MANIFEST_KEY]: serializeManifest(manifest),
      [DOCMAP_KEY]: serializeDocmap(manifest),
    });
    // A budget of 1 affords the manifest read (`take(0)` succeeds while
    // remaining > 0) but must be exhausted before the docmap read below it —
    // the docmap read is a second op, not free once the manifest is in hand.
    const budget = createSearchBudget(1);
    const result = await loadDocmapPaths(store, budget, 0);
    check("docmap paths: a budget of one op (manifest only) -> null", result === null);
    check("docmap paths: that budget is left at zero, not silently refunded", budget.remaining === 0);
  }

  {
    const manifest = manifestWith(1, [[["a.md", "v1"]]]);
    manifest.freshness = { listedAt: "2026-09-07T00:00:00.000Z", pending: 3, truncated: true };
    const store = createStore({
      [MANIFEST_KEY]: serializeManifest(manifest),
      [DOCMAP_KEY]: serializeDocmap(manifest),
    });
    const result = await loadDocmapPaths(store, createSearchBudget(10), 0);
    check(
      "docmap paths: the manifest's own freshness travels with the answer",
      result?.freshness?.listedAt === "2026-09-07T00:00:00.000Z" &&
        result.freshness.pending === 3 &&
        result.freshness.truncated === true,
    );
  }
}
