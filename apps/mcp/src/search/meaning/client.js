/**
 * The wire to one workspace's meaning index (a Cloudflare Vectorize index).
 *
 * ## One index per workspace, over HTTP
 *
 * The same shape as fast search's database, for the same reasons
 * (`../d1/client.js`): indexes are created at runtime, one per workspace, so
 * there is no binding to declare, and one index per workspace means deleting a
 * workspace's meaning search is deleting one index rather than finding its
 * vectors among everybody's. A vector query is a nearest-neighbour search over
 * one index, so an index that holds one workspace can only ever answer with
 * that workspace's notes.
 *
 * ## The token is radioactive
 *
 * Exactly `../d1/client.js`'s rule: `apiToken` arrives on the binding response,
 * lives in memory for one request, and appears in the `Authorization` header
 * and nowhere else. Never logged, never in a URL, never in an error.
 *
 * ## What an index holds
 *
 * A fingerprint per passage of a note, and as metadata only the note's path,
 * which passage it was, and the visibility tier it had when it was written.
 * **No note text.** A hit is turned back into words by reading the note from
 * the customer's own storage, under the caller's own `canSee`, at search time.
 */

import { CLOUDFLARE_API_BASE, MeaningError } from "./errors.js";
import { MEANING_DIMENSIONS, readEnvelope } from "./embed.js";

const MEANING_TIMEOUT_MS = 8_000;
const MEANING_RESPONSE_BYTE_CAP = 1_000_000;

/** Vectors per upsert request. The HTTP API takes 5,000; a refused one stays small. */
export const UPSERT_BATCH = 500;

/**
 * Ids per delete request. Vectorize refuses more than 20 ids in one request
 * with a 400 ("max id count is 20", code 40007; measured on `get_by_ids`
 * 2026-10-07). At 500, every catch-up pass that cleared old passages was
 * refused after its upsert landed, and the walk stopped after one pass.
 */
export const DELETE_BATCH = 20;

/** Delete requests in flight at once. */
export const DELETE_CONCURRENCY = 5;

/**
 * Most matches one query asks for. Vectorize returns at most 50 with metadata;
 * passages of one note can take several, so this is the ceiling, not a page.
 */
export const QUERY_TOP_K = 50;

/**
 * The `meaningIndex` sibling of a storage binding, validated, or `null`.
 *
 * Absent is the normal case — meaning search off, or not set up yet — and a
 * half-formed descriptor is treated as absent: reaching an index with two of
 * its three coordinates is not a thing to attempt.
 */
export function readMeaningIndexBinding(binding) {
  const descriptor = binding && typeof binding === "object" ? binding.meaningIndex : null;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return null;
  const { indexName, accountId, apiToken, state } = descriptor;
  if (typeof indexName !== "string" || !indexName) return null;
  if (typeof accountId !== "string" || !accountId) return null;
  if (typeof apiToken !== "string" || !apiToken) return null;
  return {
    indexName,
    accountId,
    apiToken,
    state: typeof state === "string" && state ? state : null,
  };
}

function isVector(values) {
  return (
    Array.isArray(values) &&
    values.length === MEANING_DIMENSIONS &&
    values.every((value) => typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * A client for one index, built per request from the binding. Keeps no
 * module-level state a reused isolate could carry into another tenant's call.
 */
export function createMeaningClient(descriptor, options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
  const config = readMeaningIndexBinding({ meaningIndex: descriptor });
  if (!config) throw new MeaningError("NOT_CONFIGURED");
  const base = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(
    config.accountId,
  )}/vectorize/v2/indexes/${encodeURIComponent(config.indexName)}`;

  async function post(path, body, contentType = "application/json") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEANING_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          // The token appears here and nowhere else in the process.
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": contentType,
          Accept: "application/json",
        },
        body,
        signal: controller.signal,
        // See `../d1/client.js`: workerd does not implement "error".
        redirect: "manual",
      });
    } catch {
      throw new MeaningError("UNAVAILABLE", {
        cause: controller.signal.aborted ? "timeout" : "network",
      });
    } finally {
      clearTimeout(timer);
    }
    const envelope = await readEnvelope(response, MEANING_RESPONSE_BYTE_CAP);
    return envelope.result;
  }

  /**
   * Write passages. Each `{id, values, metadata}`; a malformed one refuses the
   * whole call before anything is sent, so a bad vector is never half-written.
   */
  async function upsert(vectors) {
    const list = Array.isArray(vectors) ? vectors : [];
    for (const vector of list) {
      if (!vector || typeof vector.id !== "string" || !vector.id || !isVector(vector.values)) {
        throw new MeaningError("REFUSED", { cause: "shape" });
      }
    }
    let written = 0;
    for (let start = 0; start < list.length; start += UPSERT_BATCH) {
      const group = list.slice(start, start + UPSERT_BATCH);
      const body = group
        .map(({ id, values, metadata }) => JSON.stringify({ id, values, metadata: metadata ?? {} }))
        .join("\n");
      await post("/upsert", body, "application/x-ndjson");
      written += group.length;
    }
    return written;
  }

  /** Remove passages by id. An id that is not there is not an error. */
  async function deleteByIds(ids) {
    const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id);
    const groups = [];
    for (let start = 0; start < list.length; start += DELETE_BATCH) {
      groups.push(list.slice(start, start + DELETE_BATCH));
    }
    // A few at a time: the cap makes many small requests, and one after
    // another they would add seconds to every catch-up pass.
    for (let start = 0; start < groups.length; start += DELETE_CONCURRENCY) {
      await Promise.all(
        groups
          .slice(start, start + DELETE_CONCURRENCY)
          .map((group) => post("/delete_by_ids", JSON.stringify({ ids: group }))),
      );
    }
    return list.length;
  }

  /**
   * The passages nearest `vector`, as `{id, score, path, chunk, tier}`.
   *
   * `tiers`, when given, narrows to passages written at those visibility tiers
   * so a team member's candidates are not spent on private notes they cannot
   * open. It is a ranking aid, never the access check: tiers recorded at write
   * time can be stale, so every hit still goes through `canSee` before it is
   * shown. A match without a usable path is dropped here.
   */
  async function query(vector, { topK = QUERY_TOP_K, tiers = null } = {}) {
    if (!isVector(vector)) throw new MeaningError("REFUSED", { cause: "shape" });
    const body = {
      vector,
      topK: Math.max(1, Math.min(QUERY_TOP_K, Math.floor(topK))),
      returnValues: false,
      returnMetadata: "all",
    };
    if (Array.isArray(tiers) && tiers.length > 0) body.filter = { tier: { $in: tiers } };
    const result = await post("/query", JSON.stringify(body));
    const matches = result && Array.isArray(result.matches) ? result.matches : [];
    const out = [];
    for (const match of matches) {
      const metadata = match && typeof match.metadata === "object" && match.metadata ? match.metadata : {};
      if (typeof metadata.path !== "string" || !metadata.path) continue;
      if (typeof match.score !== "number" || !Number.isFinite(match.score)) continue;
      out.push({
        id: typeof match.id === "string" ? match.id : "",
        score: match.score,
        path: metadata.path,
        chunk: Number.isInteger(metadata.chunk) ? metadata.chunk : 0,
        tier: typeof metadata.tier === "string" ? metadata.tier : null,
      });
    }
    return out;
  }

  return { upsert, deleteByIds, query, indexName: config.indexName, state: config.state };
}
