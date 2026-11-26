/**
 * The examples index a bench run binds as `TEX_EXAMPLES` (`graph/nodes/examples.js`): the Training moments of the
 * front door, held in memory, embedded with the REAL `@cf/baai/bge-m3` over the Workers AI REST API. The node asks the
 * index for its query vector too (`embed`), so a bench run measures the same nearest moments production would find
 * through Vectorize, with the same model.
 *
 * Vectors are cached in one JSON file in `cacheDir`, keyed by the sha256 of each moment's text, so a moment whose text
 * has not changed is never embedded again. The cache holds vectors only, never the text, and is tagged with the model:
 * a different model reads as an empty cache.
 *
 * With no account or no token there is no index (`null`), and the node falls back to the fixed examples.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MEANING_DIMENSIONS, MEANING_MODEL, createRestEmbedder } from "../src/search/meaning/embed.js";

const require = createRequire(import.meta.url);
const GENERATED = require("../../../packages/tex/src/texTraining.generated.json");
const { EXAMPLES_K, indexEntries, nearestInMemory } = require("../../../packages/tex/src/texExamples.cjs");

/** The cache file's name inside `cacheDir`. */
export const EXAMPLES_CACHE_FILE = "tex-examples-vectors.json";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The cached vectors as a `hash -> number[]` map; empty for a missing, unreadable or other-model file. */
async function readCache(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.model !== MEANING_MODEL || parsed?.dimensions !== MEANING_DIMENSIONS || typeof parsed?.vectors !== "object") return new Map();
    return new Map(Object.entries(parsed.vectors));
  } catch {
    return new Map();
  }
}

/**
 * The in-memory index over the Training moments. Returns `null` when there is no account or no token (the caller leaves
 * `TEX_EXAMPLES` unset), else `{ embed, query }`: `embed(texts)` is the real model, and `query(vector, { topK })` answers
 * `{ matches: [{ id, score }] }`, best first, the way the Vectorize binding does.
 */
export async function benchExamplesIndex({ accountId, apiToken, cacheDir, fetchImpl } = {}) {
  const embed = createRestEmbedder({ accountId, apiToken, fetchImpl });
  if (embed === null) return null;
  const entries = indexEntries(GENERATED);
  const path = join(cacheDir, EXAMPLES_CACHE_FILE);
  const cache = await readCache(path);

  const hashes = entries.map((entry) => sha256(entry.text));
  const missing = [...new Map(entries.map((entry, i) => [hashes[i], entry.text])).entries()].filter(([hash]) => !cache.has(hash));
  if (missing.length > 0) {
    const fresh = await embed(missing.map(([, text]) => text));
    missing.forEach(([hash], i) => cache.set(hash, fresh[i]));
    await mkdir(cacheDir, { recursive: true });
    // Written whole, then moved in: a Lab run's answer processes build this at once, and one reading a half-written file
    // read an empty cache and embedded every moment again (2026-11-26).
    const part = `${path}.${process.pid}.part`;
    await writeFile(part, JSON.stringify({ model: MEANING_MODEL, dimensions: MEANING_DIMENSIONS, vectors: Object.fromEntries(cache) }));
    await rename(part, path);
  }

  const vectors = entries.map((entry, i) => ({ id: entry.id, values: cache.get(hashes[i]) }));
  return {
    embed,
    query: async (vector, { topK = EXAMPLES_K } = {}) => ({ matches: nearestInMemory(vectors, vector, topK) }),
  };
}

/** One build per process and per (account, cache folder): every front-door run in it shares the index. */
const built = new Map();

export function benchExamplesIndexOnce(options) {
  const key = `${options.accountId ?? ""}\n${options.cacheDir ?? ""}`;
  if (!built.has(key)) {
    const attempt = benchExamplesIndex(options);
    built.set(key, attempt);
    // A failed build is not kept, so the next run tries again.
    attempt.catch(() => built.delete(key));
  }
  return built.get(key);
}

/** Where the vectors are kept between runs; git-ignored (`apps/mcp/.gitignore`). */
export const EXAMPLES_CACHE_DIR = fileURLToPath(new URL(".cache", import.meta.url));

/**
 * The index as the gateway env's `TEX_EXAMPLES`, built on its first use, never before: a run whose config does not wire
 * the front door to the examples node spends nothing and cannot fail on it, and a build that fails rejects only that
 * query, which the node answers as a fallback to the fixed examples. `null` without a token.
 */
export function lazyExamplesIndex(options) {
  if (!options?.accountId || !options?.apiToken) return null;
  const index = () => benchExamplesIndexOnce(options);
  return {
    // The front door's wait for them in a bench run: the first query builds the index over the network.
    budgetMs: 60_000,
    embed: async (texts) => (await index()).embed(texts),
    query: async (vector, opts) => (await index()).query(vector, opts),
  };
}

/**
 * The bench's own credentials for the front door's nearest examples (`run.mjs`): a run with a Workers AI token, live or a
 * Lab run (`LAB_REAL_ENV`, real end to end), gets them; an examiner's replayed run and a --fake run never do. With no
 * token there is none, and the node falls back to the fixed examples.
 */
export const EXAMPLES_FROM_ENV = Object.freeze({
  get accountId() { return process.env.CLOUDFLARE_ACCOUNT_ID; },
  get apiToken() { return process.env.CLOUDFLARE_AI_TOKEN; },
  cacheDir: EXAMPLES_CACHE_DIR,
});
