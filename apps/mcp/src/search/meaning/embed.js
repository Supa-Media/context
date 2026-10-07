/**
 * Turning text into a meaning fingerprint: a list of 1,024 numbers that sits
 * close to the fingerprints of text about the same thing.
 *
 * ## One model, named once
 *
 * `@cf/baai/bge-m3` on Workers AI. Multilingual, because people write notes in
 * more than one language and a search in one should find a note in another;
 * 1,024 dimensions, which fits under Vectorize's 1,536 cap; and it needs no
 * instruction prefix on the query side, so a search and a note go through the
 * same call. **Changing the model changes every vector's meaning**, so a new
 * model is a new index and a full rebuild, never an in-place swap: the
 * dimension check below is what stops a mixed index from being written.
 *
 * ## Two ways to reach it, one contract
 *
 * The gateway has the Workers AI binding (`env.AI`, `[ai]` in `wrangler.toml`)
 * and uses it: same-colo, no token. The control plane runs in Convex, which has
 * no binding, so the console's own searches reach the same model over the REST
 * API with the search token (`createRestEmbedder`). Both return the same thing
 * or throw the same `MeaningError`, so nothing downstream knows which ran.
 *
 * ## What leaves, and what never does
 *
 * The text being embedded is the customer's note, sent to a model in our own
 * Cloudflare account. The fingerprint that comes back is what is stored; the
 * text is not kept anywhere by this module and never appears in a log or an
 * error. Errors carry a code from `MEANING_ERROR_CODES` and a cause of ours.
 */

import { CLOUDFLARE_API_BASE, MeaningError } from "./errors.js";

export const MEANING_MODEL = "@cf/baai/bge-m3";
export const MEANING_DIMENSIONS = 1024;

/**
 * Texts per model call. Workers AI caps a batch; staying well under it keeps
 * one long note from being the request that is refused.
 */
export const EMBED_BATCH = 32;

/** How long one embedding call may take before the caller gives up. */
const EMBED_TIMEOUT_MS = 10_000;

/** Cap on the REST response: 32 × 1,024 floats as JSON is well under this. */
const EMBED_RESPONSE_BYTE_CAP = 2_000_000;

/**
 * The fingerprints in a model answer, checked.
 *
 * Exactly one per input, each exactly `MEANING_DIMENSIONS` finite numbers. An
 * answer of any other shape is refused whole: a short vector written into the
 * index would be a note that matches nothing, and a wrong count would pair one
 * note's text with another note's fingerprint.
 */
export function vectorsFrom(output, expected) {
  const data = output && typeof output === "object" ? output.data : null;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new MeaningError("REFUSED", { cause: "shape" });
  }
  for (const vector of data) {
    if (
      !Array.isArray(vector) ||
      vector.length !== MEANING_DIMENSIONS ||
      !vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new MeaningError("REFUSED", { cause: "shape" });
    }
  }
  return data;
}

function batches(texts) {
  const out = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    out.push(texts.slice(start, start + EMBED_BATCH));
  }
  return out;
}

async function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new MeaningError("UNAVAILABLE", { cause: "timeout" })), EMBED_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An embedder over the Workers AI binding, or `null` when there is none.
 *
 * `null` is the self-hosted Worker that deleted `[ai]` from its config, and it
 * means "no meaning search here", which is a working state: exact-word search
 * is untouched.
 */
export function bindingEmbedder(ai) {
  if (!ai || typeof ai.run !== "function") return null;
  return async function embed(texts) {
    const list = Array.isArray(texts) ? texts : [];
    if (list.length === 0) return [];
    const out = [];
    for (const group of batches(list)) {
      let answer;
      try {
        answer = await withTimeout(ai.run(MEANING_MODEL, { text: group }));
      } catch (error) {
        if (error instanceof MeaningError) throw error;
        // The binding's error can quote the input, which is a note. Dropped.
        throw new MeaningError("UNAVAILABLE", { cause: "model" });
      }
      out.push(...vectorsFrom(answer, group.length));
    }
    return out;
  };
}

/**
 * An embedder over the REST API, for a caller with no binding (the control
 * plane). The token appears in the `Authorization` header and nowhere else.
 */
export function createRestEmbedder({ accountId, apiToken, fetchImpl } = {}) {
  if (typeof accountId !== "string" || !accountId || typeof apiToken !== "string" || !apiToken) {
    return null;
  }
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const endpoint = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/ai/run/${MEANING_MODEL}`;
  return async function embed(texts) {
    const list = Array.isArray(texts) ? texts : [];
    if (list.length === 0) return [];
    const out = [];
    for (const group of batches(list)) {
      let response;
      try {
        response = await withTimeout(
          doFetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ text: group }),
            redirect: "manual",
          }),
        );
      } catch (error) {
        if (error instanceof MeaningError) throw error;
        throw new MeaningError("UNAVAILABLE", { cause: "network" });
      }
      const body = await readEnvelope(response, EMBED_RESPONSE_BYTE_CAP);
      out.push(...vectorsFrom(body.result, group.length));
    }
    return out;
  };
}

/**
 * A Cloudflare `{success, result}` envelope, or a `MeaningError` saying why
 * not. Shared with `client.js`. Nothing the provider wrote is carried.
 */
export async function readEnvelope(response, cap) {
  if (!response) throw new MeaningError("UNAVAILABLE", { cause: "network" });
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    throw new MeaningError("REFUSED", { cause: "oversize" });
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new MeaningError("UNAVAILABLE", { cause: "body_read" });
  }
  if (text.length > cap) throw new MeaningError("REFUSED", { cause: "oversize" });
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (response.status !== 200 || !body || body.success !== true) {
    throw MeaningError.fromStatus(
      response.status,
      response.status === 200 ? "envelope" : `http_${response.status}`,
    );
  }
  return body;
}
