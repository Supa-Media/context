/**
 * Storage adapter checks: SigV4 signing, ListObjectsV2 parsing, rootPrefix
 * isolation, and the conditional-write capability probe.
 *
 * Offline and dependency-free — every backend is a fetch stub or an in-memory
 * map. Run as part of `node test/test.mjs`.
 *
 * Shared fixtures for `test/store/*.test.mjs`, split out of the single
 * `store.test.mjs` this file used to be part of.
 */

import { readFileSync } from "node:fs";
import worker from "../../src/index.js";
import { R2Store } from "../../src/store/r2.js";
import { S3Store, parseListObjectsV2, deriveSigningKey } from "../../src/store/s3.js";
import { DropboxStore } from "../../src/store/dropbox.js";
import { probeStore, normalizeEtag, pruneEmptyFolders, PROBE_PREFIX } from "../../src/store/index.js";
import { dropboxTaggedError as dbxTagged } from "../controlPlaneStub.mjs";

export {
  readFileSync,
  worker,
  R2Store,
  S3Store,
  parseListObjectsV2,
  deriveSigningKey,
  DropboxStore,
  probeStore,
  normalizeEtag,
  pruneEmptyFolders,
  PROBE_PREFIX,
  dbxTagged,
};

export const FAKE_CONFIG = {
  endpoint: "https://s3.example-object-storage.test",
  region: "us-east-1",
  bucket: "example-bucket",
  // Obviously fake credentials. This repo is public; never use a real one.
  accessKeyId: "AKIAEXAMPLEEXAMPLE00",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  now: () => new Date("2026-08-25T12:00:00.000Z"),
};

/** A fetch stand-in that records what was sent and replays scripted responses. */
export function fetchStub(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const call = {
      url: new URL(url),
      method: options.method,
      headers: options.headers || {},
      body: options.body,
    };
    calls.push(call);
    return (await handler(call, calls.length - 1)) || new Response("", { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

export function s3(handler, overrides = {}) {
  return new S3Store({ ...FAKE_CONFIG, ...overrides, fetchImpl: fetchStub(handler) });
}

export function listXml({ contents = [], prefixes = [], truncated = false, next = null } = {}) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>example-bucket</Name><IsTruncated>${truncated}</IsTruncated>` +
    (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
    contents
      .map(
        (item) =>
          `<Contents><Key>${item.key}</Key><LastModified>2026-08-01T10:00:00.000Z</LastModified>` +
          `<ETag>&quot;${item.etag || "abc"}&quot;</ETag><Size>${item.size ?? 10}</Size></Contents>`
      )
      .join("") +
    prefixes.map((prefix) => `<CommonPrefixes><Prefix>${prefix}</Prefix></CommonPrefixes>`).join("") +
    `</ListBucketResult>`
  );
}

/**
 * In-memory bucket with the same semantics as the R2 binding.
 *
 * The flags model the three ways a backend can look conflict-safe and not be:
 * - `ignoreIfMatch` — accepts the header and writes anyway (B2, Wasabi).
 * - `rejectAllIfMatch` — 412s every precondition, correct or not.
 * - `shapeOnlyIfMatch` — 412s an etag that does not *look* like one of its own,
 *   then ignores a well-formed but stale one. Last-writer-wins on real
 *   conflicts, while passing a probe that only tries an impossible etag.
 */
export function memoryBucket({
  ignoreIfMatch = false,
  rejectAllIfMatch = false,
  shapeOnlyIfMatch = false,
} = {}) {
  const objects = new Map();
  let counter = 0;
  return {
    objects,
    async get(key) {
      if (!objects.has(key)) return null;
      const { body, etag } = objects.get(key);
      return {
        etag,
        text: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    },
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && rejectAllIfMatch) return null;
      // Etags this bucket issues look like "m3"; anything else is malformed.
      if (expected && shapeOnlyIfMatch && !/^m\d+$/.test(expected)) return null;
      // A backend that "supports" If-Match by ignoring it — B2 and Wasabi.
      if (expected && !ignoreIfMatch && !shapeOnlyIfMatch && objects.get(key)?.etag !== expected) {
        return null;
      }
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      const etag = `m${++counter}`;
      objects.set(key, { body, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix, delimiter } = {}) {
      const keys = [...objects.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort();
      if (!delimiter) {
        return {
          objects: keys.map((key) => ({ key, size: objects.get(key).body.length, uploaded: new Date() })),
          truncated: false,
        };
      }
      const listed = [];
      const delimitedPrefixes = new Set();
      for (const key of keys) {
        const rest = key.slice((prefix || "").length);
        const slash = rest.indexOf(delimiter);
        if (slash === -1) listed.push({ key, size: objects.get(key).body.length, uploaded: new Date() });
        else delimitedPrefixes.add(`${prefix || ""}${rest.slice(0, slash + 1)}`);
      }
      return { objects: listed, delimitedPrefixes: [...delimitedPrefixes], truncated: false };
    },
  };
}

/** Dropbox response/store fixtures shared by the Dropbox and folders sections. */
export function dbxJson(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function dropbox(handler, overrides = {}) {
  return new DropboxStore({
    accessToken: "sl.FAKE-not-a-real-token",
    fetch: fetchStub(handler),
    sleep: async () => {},
    ...overrides,
  });
}
