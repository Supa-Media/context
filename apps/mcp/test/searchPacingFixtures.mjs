/**
 * Shared fixtures for the pacing checks: the bucket model and the search helpers. See searchPacing.test.mjs for the checks they serve.
 */

import { treeBacked } from "./treeBacking.mjs";
import worker from "../src/index.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { syncShardedIndex } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { createWorkerCtx } from "./workerCtx.mjs";

/** Mirrors `SEARCH_RESULT_LIMIT` in `search/visible.js`. */
export const SEARCH_RESULT_LIMIT = 10;
/** Mirrors `INTERACTIVE_BACKFILL_OPS` in `src/index.js`. */
export const INTERACTIVE_BACKFILL_OPS = 60;
/** Every tool call reads `privacy.md` before it dispatches; not the search's to spend. */
export const PRIVACY_MANIFEST_READ = 1;

export const PACING_TOKEN = `cat_pacing_owner_${"0".repeat(18)}`;

export const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  0-inbox: team\n  1-projects: team\n  2-areas: team\n" +
  "  3-resources: team\n  4-archive: team\n  5-extra: team\n\n" +
  "note_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * An in-memory bucket that also records **how many operations were in flight at
 * once**, per kind.
 *
 * That is the measurement the other fixtures cannot make and the one this whole
 * change is about: parallelizing independent reads does not move a single op
 * count, so a suite that counts ops is blind to whether a search makes eight
 * round trips or fifty-seven. `peak` is what a sequential loop can never raise
 * above 1.
 */
function rawBucket() {
  const objects = new Map();
  let etags = 0;
  const counts = { get: 0, put: 0, list: 0, delete: 0, getKeys: [] };
  const live = { get: 0, list: 0 };
  const peak = { get: 0, list: 0, shardGet: 0, noteGet: 0 };
  let liveShardGets = 0;
  let liveNoteGets = 0;

  const enter = (kind, key) => {
    live[kind] += 1;
    peak[kind] = Math.max(peak[kind], live[kind]);
    if (kind !== "get") return;
    if (key.startsWith(".context/search/v2/shard-")) {
      liveShardGets += 1;
      peak.shardGet = Math.max(peak.shardGet, liveShardGets);
    } else if (key.endsWith(".md") && key !== "privacy.md") {
      liveNoteGets += 1;
      peak.noteGet = Math.max(peak.noteGet, liveNoteGets);
    }
  };
  const leave = (kind, key) => {
    live[kind] -= 1;
    if (kind !== "get") return;
    if (key.startsWith(".context/search/v2/shard-")) liveShardGets -= 1;
    else if (key.endsWith(".md") && key !== "privacy.md") liveNoteGets -= 1;
  };

  // A real backend answers after a round trip, and a stub that resolves in the
  // same microtask hides every serialization it is asked about: awaited
  // sequentially or fired as a wave, an instant promise looks the same. One
  // macrotask per operation is the cheapest thing that does not.
  const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 0));

  const api = {
    objects,
    counts,
    peak,
    get ops() {
      return counts.get + counts.put + counts.list + counts.delete;
    },
    resetCounts() {
      counts.get = 0;
      counts.put = 0;
      counts.list = 0;
      counts.delete = 0;
      counts.getKeys = [];
      peak.get = 0;
      peak.list = 0;
      peak.shardGet = 0;
      peak.noteGet = 0;
    },
    seed(key, body) {
      objects.set(key, { body, etag: `e${(etags += 1)}`, uploaded: new Date() });
    },
    /** Note reads this call made, which is what `backfillOps` bounds. */
    noteGets() {
      return counts.getKeys.filter((key) => key.endsWith(".md") && key !== "privacy.md").length;
    },
    async get(key) {
      counts.get += 1;
      counts.getKeys.push(key);
      enter("get", key);
      try {
        await roundTrip();
        const stored = objects.get(key);
        if (!stored) return null;
        return {
          etag: stored.etag,
          text: async () => stored.body,
          arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
        };
      } finally {
        leave("get", key);
      }
    },
    async put(key, value, options = {}) {
      counts.put += 1;
      await roundTrip();
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${(etags += 1)}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      counts.delete += 1;
      await roundTrip();
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      counts.list += 1;
      enter("list", prefix);
      try {
        await roundTrip();
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
        const from = cursor ? keys.findIndex((key) => key > cursor) : 0;
        if (from === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
        const page = [];
        const prefixes = new Set();
        let index = from;
        for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
          const key = keys[index];
          const remainder = key.slice(prefix.length);
          const slash = delimiter ? remainder.indexOf(delimiter) : -1;
          if (slash === -1) {
            const stored = objects.get(key);
            page.push({ key, size: stored.body.length, uploaded: stored.uploaded, etag: stored.etag });
          } else {
            prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
          }
        }
        const truncated = index < keys.length;
        return {
          objects: page,
          delimitedPrefixes: [...prefixes],
          truncated,
          cursor: truncated ? keys[index - 1] : undefined,
        };
      } finally {
        leave("list", prefix);
      }
    },
  };
  return api;
}

export const alwaysVisible = () => true;
export const indexable = (key) =>
  key.endsWith(".md") && key !== "privacy.md" && !key.split("/").some((s) => s.startsWith("."));

/**
 * `count` notes carrying `term`, spread over `roots` **top-level** folders.
 *
 * Top-level matters and is easy to get wrong: the listing walk is delimited at
 * the root and flat inside each real folder, so a thousand notes under one root
 * is *one* listing however many subfolders it has. A fixture built that way
 * cannot say anything about folder listings overlapping — which is how the
 * first version of the check below passed for the wrong reason and then failed
 * for the right one.
 */
export const ROOTS = ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive", "5-extra"];
export function seedNotes(bucket, count, term, roots = 2) {
  const spread = Math.max(1, Math.min(roots, ROOTS.length));
  for (let i = 0; i < count; i += 1) {
    bucket.seed(
      `${ROOTS[i % spread]}/p${i % 6}/note-${i}.md`,
      `# Note ${i}\n\nThe ${term} appears here, in note ${i}.\n`
    );
  }
}

/** One answer, from whatever index is already there. No maintenance at all. */
export function search(bucket, options = {}) {
  return searchIndexedNotes(bucket, {
    isVisible: alwaysVisible,
    isIndexable: indexable,
    query: options.query ?? "rhubarb",
    budget: options.counter ?? createSearchBudget(options.budget ?? 120),
    ...options.pass,
  });
}

/**
 * One whole **request**: the answer, then the maintenance behind it, on one
 * shared subrequest counter.
 *
 * This is the shape the gateway has now — `searchIndexedNotes` reads a ready
 * index and `maintainIndexAfter` spends what is left once the response has gone
 * — and modelling it here rather than calling the two separately is the point:
 * they share a budget, so what maintenance takes is what the *next* answer does
 * not have.
 */
export async function request(bucket, options = {}) {
  const counter = createSearchBudget(options.budget ?? 120);
  const found = await search(bucket, { ...options, counter });
  await syncShardedIndex(bucket, {
    budget: counter,
    isIndexable: indexable,
    ...(options.sync ?? {}),
  });
  return found;
}

export async function callTool(env, token, name, args, { defer = true } = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    // Omitted entirely for the no-deferral case, which is what a host that
    // passes no `ctx` looks like — a self-host shim, or this suite before
    // `waitUntil` meant anything.
    defer ? ctx : undefined
  );
  const result = (await response.json())?.result;
  if (defer) await settle();
  return result?.content?.[0]?.text;
}

/** Every console.log line one call emitted, parsed where it is JSON. */
export async function captureLogs(run) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });
}

/**
 * **A QUERY MUST NOT BE A PROBE OF WHAT THE CALLER CANNOT READ.**
 *
 * Shard routing picks which shards to open from `manifest.filters`, and those
 * filters are built from every doc in a shard — private ones included, by
 * construction, since a shard mixes them. So the NUMBER of shards a query opens
 * is a function of content the caller may not see, and it used to surface: a
 * budget exhausted partway through the routed list set `shardsUnread`, which
 * became `matchCountIsFloor` and `indexIncomplete`, which `toolSearchNotes`
 * prints as "the search index is still catching up on this context".
 *
 * Measured at the gateway's default budget over 12,000 notes in 40 shards: a
 * word occurring only in the owner's private notes answered with the banner on
 * and 29 shard reads; a word occurring nowhere answered with the banner off and
 * 2 reads. Both print "(no matches)". A team-scope grant could therefore ask
 * "does this word occur in something I may not read" one word at a time — the
 * subtraction the console's census is owner-only to prevent.
 *
 * The reported floor is now a fact about the index and the budget, which no
 * query influences. What this check holds is the equality itself, so the fix
 * cannot be undone by reintroducing any query-dependent term.
 */
export function visibleOnly(prefix) {
  return (key) => !key.startsWith(prefix);
}

/**
 * The control plane's copy of the bucket, read straight from its objects: no
 * counter, no round trip, no place in the in-flight peaks. The gateway pays
 * nothing for the tree's answers in store ops (`treeBacking.mjs`).
 */
function treeSourceOf(objects) {
  return {
    async list({ prefix = "" } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      return {
        objects: keys.map((key) => ({ key, etag: objects.get(key).etag, size: objects.get(key).body.length, uploaded: objects.get(key).uploaded })),
        delimitedPrefixes: [],
        truncated: false,
      };
    },
    async get(key) {
      const stored = objects.get(key);
      return stored ? { etag: stored.etag, text: async () => stored.body } : null;
    },
  };
}

export function createBucket() {
  const bucket = rawBucket();
  return treeBacked(bucket, { source: treeSourceOf(bucket.objects) });
}
