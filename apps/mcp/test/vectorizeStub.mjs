/**
 * A STAND-IN FOR VECTORIZE, FOR TESTS AND THE BENCHMARK WORLD.
 *
 * The gateway reaches a workspace's meaning index over Cloudflare's REST API
 * (`src/search/meaning/client.js`): `/vectorize/v2/indexes/<name>/upsert`,
 * `/delete_by_ids` and `/query`. This fake answers those three from memory,
 * one index per name in the URL (the same tenancy point `createD1Backend`
 * makes: a query sent to the wrong index must be answerable wrongly, not
 * answered right by the only index there is), with a brute-force cosine
 * nearest-neighbour search over what was upserted. Vectorize's metric for
 * our indexes is cosine, so the scores a test or a benchmark reads are the
 * ones production would compute, give or take Vectorize's approximate search.
 *
 * It installs in front of whatever `fetch` is there and passes every other
 * URL on, so it stacks with the D1 stub (`searchProjection/fixtures.mjs`),
 * which claims `/d1/database/` under the same API base.
 *
 * `snapshot` and `seed` exist for the benchmark: a warmed index is copied
 * once per conversation, so a turn's write never reaches the next one.
 */

import { CLOUDFLARE_API_BASE } from "../src/search/meaning/errors.js";

export const VECTORIZE_TOKEN = "vectorize-token-not-a-real-one-0000";

const ROUTE = /\/vectorize\/v2\/indexes\/([^/]+)\/(upsert|delete_by_ids|query)$/;

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 0 : dot / norm;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * @param {{ seed?: Map<string, Map<string, {values: Float32Array, metadata: object}>> }} [options]
 *   `seed` starts the fake from a snapshot: each index's vectors are copied,
 *   so the snapshot itself is never written to.
 */
export function createVectorizeBackend({ seed } = {}) {
  /** index name → (id → {values, metadata}) */
  const indexes = new Map();
  if (seed) for (const [name, vectors] of seed) indexes.set(name, new Map(vectors));
  const requests = [];

  function indexFor(name) {
    let index = indexes.get(name);
    if (!index) {
      index = new Map();
      indexes.set(name, index);
    }
    return index;
  }

  async function handle(url, init = {}) {
    const match = ROUTE.exec(new URL(url).pathname);
    if (!match) return json({ success: false, errors: [{ code: 404, message: "not found" }] }, 404);
    const [, rawName, operation] = match;
    const name = decodeURIComponent(rawName);
    requests.push({ url, indexName: name, operation, authorization: init.headers?.Authorization ?? null });
    const index = indexFor(name);
    if (operation === "upsert") {
      // NDJSON, one vector a line, as the client sends it.
      const lines = String(init.body ?? "").split("\n").filter((line) => line.trim());
      for (const line of lines) {
        const { id, values, metadata } = JSON.parse(line);
        index.set(id, { values: Float32Array.from(values), metadata: metadata ?? {} });
      }
      return json({ success: true, result: { mutationId: `m-${requests.length}` } });
    }
    if (operation === "delete_by_ids") {
      const { ids } = JSON.parse(String(init.body ?? "{}"));
      for (const id of ids ?? []) index.delete(id);
      return json({ success: true, result: { mutationId: `m-${requests.length}` } });
    }
    const body = JSON.parse(String(init.body ?? "{}"));
    const tiers = body.filter?.tier?.$in;
    const wanted = Array.isArray(tiers) ? new Set(tiers) : null;
    const query = Float32Array.from(body.vector ?? []);
    const scored = [];
    for (const [id, entry] of index) {
      if (wanted && !wanted.has(entry.metadata?.tier)) continue;
      scored.push({ id, score: cosine(query, entry.values), metadata: entry.metadata });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const topK = Math.max(1, Math.min(50, Number(body.topK) || 50));
    return json({ success: true, result: { count: Math.min(topK, scored.length), matches: scored.slice(0, topK) } });
  }

  function install() {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(CLOUDFLARE_API_BASE) && ROUTE.test(new URL(url).pathname)) return handle(url, init);
      return previous ? previous(input, init) : new Response("", { status: 404 });
    };
    return () => {
      globalThis.fetch = previous;
    };
  }

  return {
    requests,
    install,
    handle,
    /** How many vectors one index holds. */
    size: (name) => indexes.get(name)?.size ?? 0,
    /** The vectors of one index, as a Map copy: a seed for another backend. */
    snapshot: (name) => new Map(indexes.get(name) ?? []),
    /** Every index, as `seed` takes it. */
    snapshotAll: () => new Map([...indexes].map(([name, vectors]) => [name, new Map(vectors)])),
  };
}

/**
 * A meaning-index descriptor for a test or bench workspace, in the shape
 * `/gateway/binding` returns beside the storage binding.
 */
export function meaningIndexFor(name, state = "ready", accountId = "cf-account-0000000000000000example") {
  return { indexName: `meaning-${name}`, accountId, apiToken: VECTORIZE_TOKEN, state };
}
