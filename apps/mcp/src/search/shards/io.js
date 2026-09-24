import { MANIFEST_KEY, DOCMAP_KEY, MANIFEST_PARSE_BYTE_CAP, SHARD_PARSE_BYTE_CAP } from "./constants.js";
import { parseManifest, parseDocmap, parseShard } from "./serialize.js";
import { shardKey } from "./placement.js";

// -- reading one shard -----------------------------------------------------

/**
 * Read the manifest, and nothing else. The query path's whole view of the
 * index.
 *
 * A search used to reach the manifest through `syncShardedIndex`, which meant
 * every search also listed the customer's bucket and indexed whatever it found
 * stale before answering. That is the 20-to-60-second search this whole
 * direction is about: the subrequest budget bounded what a search could
 * **spend** and nothing bounded what a person **waited for**. A search reads a
 * ready index now, and the maintenance that makes it ready runs behind the
 * response.
 *
 * One op. `null` for every way the manifest can fail to arrive — absent,
 * refused, oversized, corrupt, no budget — because to this caller they mean the
 * same thing: there is nothing here to answer from, say so and let the surface
 * decide what to do about it.
 *
 * @param {import("../../store/index.js").ContextStore} store
 * @param {ReturnType<typeof createSearchBudget>} budget
 * @param {number} reserve store ops kept back for the caller's later work
 * @param {number} [byteCap]
 * @returns {Promise<ReturnType<typeof emptyManifest>|null>}
 */
export async function loadIndexManifest(store, budget, reserve, byteCap = MANIFEST_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : MANIFEST_PARSE_BYTE_CAP;
  if (!budget.take(reserve)) return null;
  const stored = await store.get(MANIFEST_KEY);
  if (!stored) return null;
  const bytes = await stored.arrayBuffer();
  if (bytes.byteLength > cap) return null;
  return parseManifest(new TextDecoder().decode(bytes), cap);
}

/**
 * Every note path the search index's docmap currently knows about, sorted.
 *
 * Built for link resolution (`docs/decisions/app-and-console.md`, "L1"): a
 * bare `[[name]]` in the editor and the `[[` completion both need the whole
 * bucket's note paths, and the file tree only knows the folders somebody has
 * expanded. Rather than a second index — a full bucket listing on its own
 * budget, paid on the customer's request quota just to learn what this module
 * already tracks — this reads the *diff surface* the sharded sync already
 * maintains behind every search's response.
 *
 * Two ops: the manifest (for its `shardCount`, which is what tells a docmap
 * apart from one for a different index layout) and then the docmap itself.
 * `null` for every way either can fail to arrive — no budget, absent,
 * refused, oversized, corrupt, or a docmap for a shard count the manifest
 * does not recognise — because to a caller resolving a link these all mean
 * the same thing: nothing here to resolve against yet. That is deliberately
 * an *honest failure* rather than a wrong one — a link that is not drawn yet,
 * never a link drawn at the wrong path — which is why this never falls back
 * to a listing: a derivative that is behind is exactly the failure mode this
 * function exists to report rather than paper over.
 *
 * @param {import("../../store/index.js").ContextStore} store
 * @param {ReturnType<typeof createSearchBudget>} budget
 * @param {number} reserve store ops kept back for the caller's later work
 * @returns {Promise<{ paths: string[], freshness: ReturnType<typeof emptyManifest>["freshness"] } | null>}
 */
export async function loadDocmapPaths(store, budget, reserve) {
  const manifest = await loadIndexManifest(store, budget, reserve);
  if (manifest === null) return null;
  if (!budget.take(reserve)) return null;
  const stored = await store.get(DOCMAP_KEY);
  if (!stored) return null;
  const bytes = await stored.arrayBuffer();
  if (bytes.byteLength > MANIFEST_PARSE_BYTE_CAP) return null;
  const docsByShard = parseDocmap(new TextDecoder().decode(bytes), manifest.shardCount);
  if (docsByShard === null) return null;
  const paths = new Set();
  for (const docs of docsByShard) {
    for (const path of docs.keys()) paths.add(path);
  }
  return { paths: [...paths].sort(), freshness: manifest.freshness };
}

/**
 * Read and parse one shard, for one budget op.
 *
 * The **one** loader: the query path streams shards through this and so does
 * the sync loop below, because a second reader is a second place for the byte
 * cap, the parse rules or the budget discipline to drift.
 *
 * `null` covers every way a shard can fail to arrive — no budget, absent,
 * refused by the backend, oversized, corrupt — on purpose: to every caller the
 * answer is the same, rebuild it from the notes. A caller that needs to tell a
 * budget refusal apart checks `budget.remaining` before calling, and the sync
 * loop below does exactly that, because "empty" and "could not look" must not
 * be confused where the next step is a write.
 *
 * @param {import("../../store/index.js").ContextStore} store
 * @param {ReturnType<typeof createSearchBudget>} budget
 * @param {number} reserve store ops kept back for the caller's later work
 * @param {number} id shard id
 * @param {number} [byteCap]
 * @returns {Promise<ReturnType<typeof emptyShard>|null>}
 */
export async function loadShard(store, budget, reserve, id, byteCap = SHARD_PARSE_BYTE_CAP) {
  const bytes = await fetchShardBytes(store, budget, reserve, id, byteCap);
  return bytes ? decodeShard(bytes, byteCap) : null;
}

/**
 * The read half of `loadShard`: one shard's stored bytes, or `null`.
 *
 * Held apart from the parse so a caller can have several reads in flight and
 * still parse **one at a time** — the query walk does, in waves of
 * `SHARD_READ_CONCURRENCY`, which is the fetch/parse split CONTRACT.md § Query
 * named as the follow-up to its sequential walk. The memory bound v2 exists for
 * survives that only because what a wave holds is bytes: six `ArrayBuffer`s
 * under the cap is at most 12MB, where six *parsed* shards would be six times
 * the peak this whole format is arranged to keep at one.
 *
 * The byte cap is applied here rather than only at the parse, for the same
 * reason it always was — the length is read from the bytes, never from a
 * header, because the header is the backend's word for it — so an oversized
 * object is dropped before anything decodes it.
 *
 * `null` covers every way a read can fail: no budget, absent, refused by the
 * backend, oversized. As with `loadShard`, a caller that must tell a budget
 * refusal from an absence checks `budget.remaining` before calling.
 */
export async function fetchShardBytes(store, budget, reserve, id, byteCap = SHARD_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : SHARD_PARSE_BYTE_CAP;
  if (!budget.take(reserve)) return null;
  try {
    const stored = await store.get(shardKey(id));
    if (!stored) return null;
    const bytes = await stored.arrayBuffer();
    if (bytes.byteLength > cap) return null;
    return bytes;
  } catch {
    // One unreadable shard must not cost the whole search its answer. The op
    // was already spent, so a bucket of unreadable shards still terminates.
    return null;
  }
}

/** The parse half: bytes in, a shard or `null` out. Never throws. */
export function decodeShard(bytes, byteCap = SHARD_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : SHARD_PARSE_BYTE_CAP;
  try {
    if (!bytes || bytes.byteLength > cap) return null;
    return parseShard(new TextDecoder().decode(bytes), cap);
  } catch {
    return null;
  }
}

