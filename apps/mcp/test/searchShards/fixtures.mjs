/**
 * Shared fixtures for `test/searchShards/*.test.mjs`, split out of the
 * original searchShards.test.mjs — see searchShards.test.mjs for the module
 * overview and the sabotage-testing record.
 */

import { R2Store } from "../../src/store/r2.js";
import { NOTE_INDEX_CHAR_CAP, createSearchBudget } from "../../src/search/maintain.js";
import {
  DOCMAP_KEY,
  LEGACY_V1_KEY,
  MANIFEST_KEY,
  MANIFEST_PARSE_BYTE_CAP,
  SHARD_PARSE_BYTE_CAP,
  chooseShardCount,
  emptyManifest,
  emptyShard,
  fnv1a32,
  loadShard,
  parseDocmap,
  parseManifest,
  parseShard,
  serializeDocmap,
  serializeManifest,
  serializeShard,
  shardKey,
  shardOf,
  syncShardedIndex,
} from "../../src/search/shards.js";

import { addDoc } from "../../src/search/indexer.js";
import { buildTermFilter } from "../../src/search/filter.js";


export {
  R2Store,
  NOTE_INDEX_CHAR_CAP,
  createSearchBudget,
  DOCMAP_KEY,
  LEGACY_V1_KEY,
  MANIFEST_KEY,
  MANIFEST_PARSE_BYTE_CAP,
  SHARD_PARSE_BYTE_CAP,
  chooseShardCount,
  emptyManifest,
  emptyShard,
  fnv1a32,
  loadShard,
  parseDocmap,
  parseManifest,
  parseShard,
  serializeDocmap,
  serializeManifest,
  serializeShard,
  shardKey,
  shardOf,
  syncShardedIndex,
  addDoc,
  buildTermFilter,
};

export const encoder = new TextEncoder();

/**
 * An in-memory bucket that pages and delimits the way R2 does, reports an etag
 * per listed object as R2 and S3 both do, and counts every call **by key** —
 * "which shard was re-read" is the question most of this file asks.
 *
 * A local copy rather than an import from `searchIntegration.test.mjs`: a test
 * fixture shared between two files is a fixture neither file can change, and
 * this one needs delete counting and per-key put counting that one does not.
 */
export function createBucket() {
  const objects = new Map();
  let etags = 0;
  const counts = { get: 0, put: 0, list: 0, delete: 0, gets: [], puts: [], noteGets: [] };
  const failGetKeys = new Set();
  let onBeforePut = null;

  const api = {
    objects,
    counts,
    failGetKeys,
    listEtags: true,
    setBeforePut(hook) {
      onBeforePut = hook;
    },
    resetCounts() {
      counts.get = 0;
      counts.put = 0;
      counts.list = 0;
      counts.delete = 0;
      counts.gets = [];
      counts.puts = [];
      counts.noteGets = [];
    },
    /** Every store op one call spent, which is what the budget is about. */
    get ops() {
      return counts.get + counts.put + counts.list + counts.delete;
    },
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    etagOf(key) {
      return objects.get(key)?.etag;
    },
    remove(key) {
      objects.delete(key);
    },
    async get(key) {
      counts.get += 1;
      counts.gets.push(key);
      if (key.endsWith(".md") && key !== "privacy.md") counts.noteGets.push(key);
      if (failGetKeys.has(key)) throw new Error("storage backend refused the read");
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => encoder.encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      counts.put += 1;
      counts.puts.push(key);
      if (onBeforePut) onBeforePut(key, options);
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      counts.delete += 1;
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      counts.list += 1;
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
          page.push({
            key,
            size: stored.body.length,
            uploaded: stored.uploaded,
            ...(api.listEtags ? { etag: stored.etag } : {}),
          });
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
    },
  };
  return api;
}

/** Canonical FNV-1a over UTF-8 octets, computed the allocating way. */
export function referenceFnv1a32(value) {
  let hash = 2166136261;
  for (const byte of encoder.encode(value)) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
}

/** The stored manifest, parsed — what a *later* pass would actually read. */
/**
 * The manifest as the sync sees it: the stored object, with the diff read back
 * out of the docmap beside it.
 *
 * Two objects since the manifest became the query surface — a query needs a
 * shard count, a filter and a freshness record, and needed none of the
 * `[path, version]` pair per note that used to make it the largest thing a
 * search downloaded. Every assertion below that reads `docsByShard` is
 * asserting a fact about the *diff*, so this helper puts the two halves back
 * together rather than each of those checks learning about the split.
 */
export function storedManifest(bucket) {
  const raw = bucket.objects.get(MANIFEST_KEY);
  if (!raw) return null;
  const manifest = parseManifest(raw.body);
  if (!manifest) return null;
  const docmap = bucket.objects.get(DOCMAP_KEY);
  if (docmap) {
    const docsByShard = parseDocmap(docmap.body, manifest.shardCount);
    if (docsByShard) manifest.docsByShard = docsByShard;
  }
  return manifest;
}

export function storedShard(bucket, id) {
  const raw = bucket.objects.get(shardKey(id));
  return raw ? parseShard(raw.body) : null;
}

export function bytesOf(text) {
  return encoder.encode(text).byteLength;
}

/**
 * `n` note paths under `folder` that `shardOf` puts in shard `id`.
 *
 * Bounded rather than open: a `shardOf` that answers one constant — which is
 * the first sabotage anybody drives at this file — turns an unbounded search
 * for a path in shard 1 into a hung run, and a hung run is a sabotage that
 * reports nothing at all rather than a failing check.
 */
export function pathsForShard(shardCount, id, n, folder = "1-projects") {
  const found = [];
  for (let i = 0; found.length < n && i < 10_000; i += 1) {
    const path = `${folder}/note-${i}.md`;
    if (shardOf(path, shardCount) === id) found.push(path);
  }
  if (found.length < n) throw new Error(`no path lands in shard ${id} of ${shardCount}`);
  return found;
}

/** Run passes until the sync says it has nothing left, or give up loudly. */
export async function converge(store, budget = 400) {
  let last = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await syncShardedIndex(store, { budget: createSearchBudget(budget) });
    if (last.pending === 0) break;
  }
  return last;
}

