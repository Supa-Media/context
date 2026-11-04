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

import { CLOUDFLARE_API_BASE, MeaningError, providerHint, providerWords } from "./errors.js";

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

function isInputRefusal(error) {
  return error instanceof MeaningError &&
    error.code === "REFUSED" &&
    error.failureCause === "http_400" &&
    (error.providerCodes.includes(3030) || error.providerCodes.includes(8006));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/**
 * A passage as the model can take it: half of a broken emoji (a lone surrogate) becomes U+FFFD and control
 * characters become spaces. The Workers AI binding answered every build of one workspace's object with 8006,
 * "invalid data, not valid JSON" (2026-11-04), for a passage that did not survive the trip as JSON; the meaning of a
 * passage does not live in either.
 */
export function modelInput(text) {
  return typeof text === "string" ? text.replace(LONE_SURROGATE, "\uFFFD").replace(CONTROL, " ") : "";
}

/** Keep a refused passage useful while bounding a model input. No note text enters errors. */
function shorterInput(text, limit, offset = 0) {
  return Array.from(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " "))
    .slice(offset, offset + limit)
    .join("");
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
  async function request(group) {
    let answer;
    try {
      answer = await withTimeout(ai.run(MEANING_MODEL, { text: group }));
    } catch (error) {
      if (error instanceof MeaningError) throw error;
      // The binding's error can quote the input, which is a note: only a leading numeric provider code is kept
      // (Workers AI's "3030: ..." for an input it refused), never the words after it. A refusal reads as the REST
      // API's does, so both embedders isolate and shorten a refused passage alike (`withInputFallback`).
      const code = /^\s*(\d{4})\b/.exec(typeof error?.message === "string" ? error.message : "");
      const providerCodes = code ? [Number(code[1])] : [];
      // 8006 is the binding's "invalid data" for a request it could not read: like 3030, about this input.
      if (providerCodes[0] === 3030 || providerCodes[0] === 8006) throw new MeaningError("REFUSED", { cause: "http_400", operation: "embed", providerCodes });
      // Past the code, only which of our words the message was about (`providerHint`), never the message.
      const hint = providerHint(typeof error?.message === "string" ? error.message.replace(/^\s*\d{4}\s*:?/, "") : "");
      const words = providerWords(error?.message, group);
      throw new MeaningError("UNAVAILABLE", { cause: "model", operation: "embed", providerCodes, hint, providerWords: words });
    }
    return vectorsFrom(answer, group.length);
  }
  const fallback = withInputFallback(request);
  return async function embed(texts) {
    const list = Array.isArray(texts) ? texts : [];
    if (list.length === 0) return [];
    const out = [];
    for (const group of batches(list)) out.push(...(await fallback(group)));
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
  async function request(group) {
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
    const body = await readEnvelope(response, EMBED_RESPONSE_BYTE_CAP, "embed");
    return vectorsFrom(body.result, group.length);
  }

  const requestWithInputFallback = withInputFallback(request);
  return async function embed(texts) {
    const list = Array.isArray(texts) ? texts : [];
    if (list.length === 0) return [];
    const out = [];
    for (const group of batches(list)) {
      out.push(...await requestWithInputFallback(group));
    }
    return out;
  };
}

/**
 * `request` (one model call for a group of passages) with Workers AI's input refusal (3030) isolated: a refused
 * group is split, a refused passage is tried shorter and in other sections, and only a passage the model refuses
 * every way is thrown, as `REFUSED` with the probe's verdict. Shared by both embedders.
 */
function withInputFallback(request) {
  async function requestWithInputFallback(raw) {
    const group = raw.map(modelInput);
    try {
      return await request(group);
    } catch (error) {
      if (!isInputRefusal(error)) throw error;
      // 3030 is the provider's input-validation refusal. A whole batch may
      // exceed its limit even when each passage is valid; isolate first.
      if (group.length > 1) {
        const middle = Math.floor(group.length / 2);
        const left = await requestWithInputFallback(group.slice(0, middle));
        const right = await requestWithInputFallback(group.slice(middle));
        return [...left, ...right];
      }
      // If one passage is still rejected, keep a shorter prefix. These
      // retries are bounded and never mark an unembedded note as indexed.
      for (const limit of [1024, 256]) {
        const shorter = shorterInput(group[0], limit);
        if (!shorter || shorter === group[0]) continue;
        try {
          return await request([shorter]);
        } catch (retryError) {
          if (!isInputRefusal(retryError)) throw retryError;
        }
      }
      // A bad opening segment can survive both prefix retries. Try clean
      // sections elsewhere before giving up on this passage. The 1,024-char
      // sections keep much more of its meaning when they work.
      const length = Array.from(group[0]).length;
      for (const limit of [1024, 256]) {
        if (length <= limit) continue;
        for (const offset of [Math.floor((length - limit) / 2), length - limit]) {
          const section = shorterInput(group[0], limit, offset);
          if (!section) continue;
          try {
            return await request([section]);
          } catch (retryError) {
            if (!isInputRefusal(retryError)) throw retryError;
          }
        }
      }
      // A fixed, content-free probe distinguishes a particular input from a
      // provider-wide refusal. Never carry the provider's message or the
      // rejected passage into the diagnostic error.
      let probeStatus = "accepted";
      try {
        await request(["A short document"]);
      } catch (probeError) {
        probeStatus = isInputRefusal(probeError) ? "refused" : "other_error";
      }
      throw new MeaningError("REFUSED", {
        cause: "http_400",
        operation: "embed",
        providerCodes: error.providerCodes,
        probeStatus,
        inputChars: length,
      });
    }
  }
  return requestWithInputFallback;
}

/**
 * A Cloudflare `{success, result}` envelope, or a `MeaningError` saying why
 * not. Shared with `client.js`. Nothing the provider wrote is carried.
 */
export async function readEnvelope(response, cap, operation) {
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
      {
        operation,
        providerCodes: Array.isArray(body?.errors) ? body.errors.map((entry) => entry?.code) : [],
      },
    );
  }
  return body;
}
