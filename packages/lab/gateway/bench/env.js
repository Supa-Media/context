/**
 * The environment a bench object and a bench search run in (`store.js`, `route.js`): the gateway's code over the
 * `BENCH_STORE` namespace and nothing else of the deployment's.
 *
 * - `WORKSPACE_STORE` is `BENCH_STORE`, so every workspace and person object a bench search opens is a bench object,
 *   never a real one.
 * - `GATEWAY_SECRET` is the gateway's own with a suffix: a binding sealed here opens nowhere else, and the control
 *   plane would refuse it.
 * - The control plane is a host that does not resolve: a search's timing and usage rows go nowhere.
 * - `AI` reads and writes the bench's vector cache first (`cachedAi`): a text is embedded once, whichever copy asks.
 */

import { MEANING_MODEL } from "../../../../apps/mcp/src/search/meaning/embed.js";
import { sha256Hex } from "../../../../apps/mcp/src/controlPlane/client.js";

/**
 * The object that keeps the worlds list (`serveWorlds`) and, before 2026-11-22, the whole vector cache; its vectors
 * are still read when a shard has none, and copied into the shard.
 */
export const VECTORS_OBJECT = "bench-vectors";
/**
 * The vector cache is kept in this many objects, by its key's first hex digit. One object answers one call at a time,
 * so with every copy of a world building at once a single cache was the queue every build waited in (a 16-copy load
 * took about 6 minutes cloning against a copy that built alone in under one).
 */
export const VECTOR_SHARDS = 16;
const shardOf = (key) => `${VECTORS_OBJECT}-${parseInt(key[0], 16) % VECTOR_SHARDS}`;
/** Its one call. */
export const VECTORS_PATH = "/bench-vectors";
/** The same object's list of worlds, by when each was last used (`serveWorlds`). */
export const WORLDS_PATH = "/bench-worlds";
/** A world nobody has used this long is dropped. */
export const WORLD_IDLE_MS = 7 * 86_400_000;

const made = new WeakMap();

/** The bench environment for a deployment's `env`, or `env` itself when it already is one (`objectWorld.mjs`). */
export function benchEnvOf(env) {
  if (env?.BENCH_WORLD === true) return env;
  if (!env?.BENCH_STORE) throw new Error("this deployment has no bench objects");
  if (made.has(env)) return made.get(env);
  const out = {
    BENCH_WORLD: true,
    GATEWAY_SECRET: `${typeof env.GATEWAY_SECRET === "string" ? env.GATEWAY_SECRET : ""}\u0000bench`,
    CONTROL_PLANE_URL: "https://control.bench.invalid",
    CONTROL_PLANE_SECRET: "b".repeat(40),
    SEARCH_SUBREQUEST_BUDGET: "600",
    WORKSPACE_STORE: env.BENCH_STORE,
    BENCH_STORE: env.BENCH_STORE,
    ...(env.AI ? { AI: cachedAi(env.AI, env.BENCH_STORE) } : {}),
  };
  made.set(env, out);
  return out;
}

/** `env` with a Lab draft's search settings (`SEARCH_SETTINGS`), read by the gateway's side of a search only. */
export function withSettings(env, settings) {
  return typeof settings === "string" && settings !== "" ? { ...env, SEARCH_SETTINGS: settings } : env;
}

const f32 = (vector) => Array.from(Float32Array.from(vector));

/**
 * Workers AI with the embedding model's answers kept in the vector cache object. Every vector comes back as the
 * cache keeps it (float32), the first time too, so every copy of a world holds the same numbers and ranks alike.
 * Every other model (the reranker) is asked as it is.
 */
export function cachedAi(ai, namespace) {
  const ask = async (name, body) => await (await namespace.get(namespace.idFromName(name)).fetch(new Request(`https://bench.internal${VECTORS_PATH}`, { method: "POST", body: JSON.stringify(body) }))).json();
  /** `ask` of every shard the keys fall in, at once; answers every vector found. */
  const spread = async (keys, body) => {
    const byShard = new Map();
    for (const key of keys) byShard.set(shardOf(key), [...(byShard.get(shardOf(key)) ?? []), key]);
    const answers = await Promise.all([...byShard].map(([name, list]) => ask(name, body(list))));
    return Object.assign({}, ...answers.map((answer) => answer?.vectors ?? {}));
  };
  const putAll = async (put) => await spread(Object.keys(put), (list) => ({ put: Object.fromEntries(list.map((key) => [key, put[key]])) }));
  return {
    async run(model, input, ...rest) {
      if (model !== MEANING_MODEL || !Array.isArray(input?.text)) return await ai.run(model, input, ...rest);
      const texts = input.text.map(String);
      const keys = await Promise.all(texts.map((text) => sha256Hex(`${model}\u0000${text}`)));
      const known = await spread(keys, (list) => ({ get: list }));
      // Vectors cached before the shards are in the one old cache: read there once, and kept in their shard.
      const unsharded = [...new Set(keys.filter((key) => !Array.isArray(known[key])))];
      if (unsharded.length > 0) {
        const { vectors: old = {} } = await ask(VECTORS_OBJECT, { get: unsharded });
        if (Object.keys(old).length > 0) {
          await putAll(old);
          Object.assign(known, old);
        }
      }
      const missing = texts.map((_, i) => i).filter((i) => !Array.isArray(known[keys[i]]));
      if (missing.length > 0) {
        const answer = await ai.run(model, { ...input, text: missing.map((i) => texts[i]) }, ...rest);
        const data = Array.isArray(answer?.data) ? answer.data : [];
        if (data.length !== missing.length) return answer;
        const put = {};
        missing.forEach((i, j) => (put[keys[i]] = f32(data[j])));
        await putAll(put);
        Object.assign(known, put);
      }
      return { shape: [texts.length, known[keys[0]].length], data: keys.map((key) => f32(known[key])) };
    },
  };
}

/** The vector cache object's one call: `{get: [key]}` answers `{vectors: {key: [..]}}`; `{put: {key: [..]}}` keeps them. */
export async function serveVectors(sql, request) {
  sql.exec("CREATE TABLE IF NOT EXISTS bench_vectors (key TEXT PRIMARY KEY, vector BLOB NOT NULL)");
  const input = await request.json().catch(() => ({}));
  if (input.put && typeof input.put === "object") {
    for (const [key, vector] of Object.entries(input.put)) {
      if (!/^[0-9a-f]{64}$/.test(key) || !Array.isArray(vector)) continue;
      sql.exec("INSERT OR IGNORE INTO bench_vectors (key, vector) VALUES (?, ?)", key, Float32Array.from(vector).buffer);
    }
    return Response.json({ kept: true });
  }
  const vectors = {};
  for (const key of Array.isArray(input.get) ? input.get.slice(0, 256) : []) {
    const row = sql.exec("SELECT vector FROM bench_vectors WHERE key = ?", String(key)).toArray()[0];
    if (row) vectors[key] = Array.from(new Float32Array(row.vector instanceof ArrayBuffer ? row.vector : new Uint8Array(row.vector).slice().buffer));
  }
  return Response.json({ vectors });
}

/**
 * The worlds kept, with their objects and when a run last used each: `{touch: {world, ids}}` notes a run's use (and
 * any ids it set up), and answers the worlds idle past `WORLD_IDLE_MS`, forgotten here, for the caller to drop.
 */
export async function serveWorlds(sql, request, now = Date.now()) {
  sql.exec("CREATE TABLE IF NOT EXISTS bench_worlds (world TEXT PRIMARY KEY, ids TEXT NOT NULL, used INTEGER NOT NULL)");
  const input = await request.json().catch(() => ({}));
  const world = String(input.touch?.world ?? "");
  if (/^[0-9a-f]{32}$/.test(world)) {
    const row = sql.exec("SELECT ids FROM bench_worlds WHERE world = ?", world).toArray()[0];
    const ids = [...new Set([...(row ? JSON.parse(row.ids) : []), ...(Array.isArray(input.touch.ids) ? input.touch.ids.map(String) : [])])];
    sql.exec("INSERT INTO bench_worlds (world, ids, used) VALUES (?, ?, ?) ON CONFLICT(world) DO UPDATE SET ids = excluded.ids, used = excluded.used", world, JSON.stringify(ids), now);
  }
  const idle = sql.exec("SELECT world, ids FROM bench_worlds WHERE used < ?", now - WORLD_IDLE_MS).toArray();
  for (const row of idle) sql.exec("DELETE FROM bench_worlds WHERE world = ?", row.world);
  return Response.json({ idle: idle.map((row) => ({ world: row.world, ids: JSON.parse(row.ids) })) });
}
