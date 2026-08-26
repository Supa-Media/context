/**
 * ContextStore — the single seam between the gateway and a customer's bucket.
 *
 * Everything above this boundary works in real note keys ("1-projects/foo.md").
 * Tenancy is bucket-level: an adapter must never namespace, rewrite, or
 * decorate a key. The one exception is a customer-chosen `rootPrefix`, which is
 * applied *inside* the adapter and is invisible to every caller above it.
 *
 * The surface is deliberately the smallest thing the worker actually uses:
 *
 *   get(key)                          → StoredObject | null
 *   put(key, value, options?)         → { etag } | null   (null = precondition failed)
 *   delete(key)                       → void
 *   list({ prefix, delimiter, cursor, limit }) → ListResult
 *
 * Plus a capability descriptor:
 *
 *   store.capabilities = { conditionalWrite: boolean }
 *
 * `conditionalWrite` is what makes `put(key, value, { onlyIf: { etagMatches } })`
 * meaningful. R2 and AWS S3 honour it. Backblaze B2 and Wasabi accept the
 * header and ignore it, which would silently turn every conflict-safe write
 * into a last-writer-wins overwrite — so a store's claim is never taken on
 * faith. Call `probeStore()` at connect time and degrade honestly.
 *
 * @typedef {Object} StoredObject
 * @property {string} etag              unquoted etag, comparable across backends
 * @property {() => Promise<string>} text
 * @property {() => Promise<ArrayBuffer>} arrayBuffer
 *
 * @typedef {Object} ListedObject
 * @property {string} key
 * @property {number} size
 * @property {Date} uploaded
 *
 * @typedef {Object} ListResult
 * @property {ListedObject[]} objects
 * @property {string[]} [delimitedPrefixes]
 * @property {boolean} truncated
 * @property {string} [cursor]
 *
 * @typedef {Object} PutOptions
 * @property {{ etagMatches: string }} [onlyIf]
 *
 * @typedef {Object} ContextStore
 * @property {{ conditionalWrite: boolean }} capabilities
 * @property {(key: string) => Promise<StoredObject|null>} get
 * @property {(key: string, value: string|ArrayBuffer|Uint8Array, options?: PutOptions) => Promise<{etag: string}|null>} put
 * @property {(key: string) => Promise<void>} delete
 * @property {(options?: {prefix?: string, delimiter?: string, cursor?: string, limit?: number}) => Promise<ListResult>} list
 */

/** Probe objects live under a dot-prefixed path, so they are never note surface. */
export const PROBE_PREFIX = ".context-probe/";

/**
 * An etag no real object can have. Used to prove that a wrong precondition is
 * actually rejected rather than quietly ignored.
 */
const IMPOSSIBLE_ETAG = "00000000000000000000000000000000-probe";

/** Normalize an etag so S3's quoted form compares equal to R2's bare form. */
export function normalizeEtag(value) {
  if (typeof value !== "string") return value;
  return value
    .trim()
    .replace(/^W\//i, "")
    .replace(/^"(.*)"$/, "$1");
}

/** "" or a prefix guaranteed to end in exactly one "/". */
export function normalizeRootPrefix(value) {
  if (!value) return "";
  const trimmed = String(value).replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

/** Caller key → backend key. */
export function applyRootPrefix(rootPrefix, key) {
  return rootPrefix ? `${rootPrefix}${key}` : key;
}

/** Backend key → caller key. Returns null for anything outside the prefix. */
export function stripRootPrefix(rootPrefix, key) {
  if (!rootPrefix) return key;
  return key.startsWith(rootPrefix) ? key.slice(rootPrefix.length) : null;
}

/** Re-key a backend list page into caller-visible keys. */
export function stripListResult(rootPrefix, page) {
  if (!rootPrefix) return page;
  const objects = [];
  for (const object of page.objects || []) {
    const key = stripRootPrefix(rootPrefix, object.key);
    if (key !== null) objects.push({ ...object, key });
  }
  const delimitedPrefixes = [];
  for (const prefix of page.delimitedPrefixes || []) {
    const stripped = stripRootPrefix(rootPrefix, prefix);
    if (stripped !== null) delimitedPrefixes.push(stripped);
  }
  return { ...page, objects, delimitedPrefixes };
}

function isContextStore(store) {
  return Boolean(
    store &&
      typeof store.get === "function" &&
      typeof store.put === "function" &&
      typeof store.delete === "function" &&
      typeof store.list === "function"
  );
}

function errorMessage(error) {
  return String(error?.message || error || "unknown error").slice(0, 300);
}

/**
 * Verify a store is reachable, writable, and whether conditional writes are
 * *actually* enforced — by writing a temp object and then trying to overwrite
 * it with a deliberately wrong If-Match. A backend that accepts that write has
 * no conflict detection, whatever it advertises.
 *
 * Never throws, and never reports a capability it did not observe. The temp
 * object is cleaned up; `cleanedUp: false` says it was left behind.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   reachable: boolean,
 *   writable: boolean,
 *   capabilities: { conditionalWrite: boolean },
 *   conditionalWrite: { declared: boolean, verified: boolean, mismatch: boolean, detail: string },
 *   cleanedUp: boolean,
 *   errors: string[],
 * }>}
 */
export async function probeStore(store, { keyPrefix = PROBE_PREFIX } = {}) {
  const declared = Boolean(store?.capabilities?.conditionalWrite);
  const result = {
    ok: false,
    reachable: false,
    writable: false,
    capabilities: { conditionalWrite: false },
    conditionalWrite: { declared, verified: false, mismatch: declared, detail: "not tested" },
    cleanedUp: true,
    errors: [],
  };

  if (!isContextStore(store)) {
    result.errors.push("not a ContextStore: get/put/delete/list are required");
    result.conditionalWrite.detail = "store is unusable";
    return result;
  }

  try {
    await store.list({ prefix: keyPrefix, limit: 1 });
    result.reachable = true;
  } catch (error) {
    result.errors.push(`list failed: ${errorMessage(error)}`);
    result.conditionalWrite.detail = "store unreachable";
    return result;
  }

  const key = `${keyPrefix}${crypto.randomUUID()}.probe`;
  const original = "context store capability probe";
  const overwrite = "context store capability probe — must not land";
  try {
    const written = await store.put(key, original);
    result.writable = Boolean(written && written.etag);
    if (!result.writable) result.errors.push("put returned no etag; the store may be read-only");
  } catch (error) {
    result.errors.push(`put failed: ${errorMessage(error)}`);
    result.conditionalWrite.detail = "store not writable";
    return result;
  }
  if (!result.writable) {
    result.conditionalWrite.detail = "store not writable";
    await cleanUpProbe(store, key, result);
    return result;
  }

  try {
    const conditional = await store.put(key, overwrite, {
      onlyIf: { etagMatches: IMPOSSIBLE_ETAG },
    });
    if (conditional === null || conditional === undefined) {
      result.conditionalWrite.verified = true;
      result.conditionalWrite.detail = "a deliberately wrong If-Match was rejected";
    } else if ((await readProbe(store, key)) === original) {
      // Refused the write but signalled success. Callers branch on a null
      // return, so this store cannot be trusted to report conflicts.
      result.conditionalWrite.detail =
        "the store reported success for a write that did not land; conflicts are not reportable";
    } else {
      result.conditionalWrite.detail =
        "the store overwrote an object despite a wrong If-Match; conditional writes are ignored";
      result.errors.push("conditional write is not enforced by this backend");
    }
  } catch (error) {
    // Some backends signal a failed precondition by throwing. That still keeps
    // the object safe, but it is not the contract callers branch on.
    const unchanged = (await readProbe(store, key)) === original;
    result.conditionalWrite.detail = unchanged
      ? `conditional write raised instead of returning null: ${errorMessage(error)}`
      : `conditional write raised and the object changed: ${errorMessage(error)}`;
    result.errors.push("conditional write did not return null on a failed precondition");
  }

  await cleanUpProbe(store, key, result);

  result.capabilities.conditionalWrite = result.conditionalWrite.verified;
  result.conditionalWrite.mismatch = declared && !result.conditionalWrite.verified;
  result.ok = result.reachable && result.writable && !result.conditionalWrite.mismatch;
  return result;
}

async function readProbe(store, key) {
  try {
    const object = await store.get(key);
    return object ? await object.text() : null;
  } catch {
    return null;
  }
}

async function cleanUpProbe(store, key, result) {
  try {
    await store.delete(key);
  } catch (error) {
    result.cleanedUp = false;
    result.errors.push(`probe cleanup failed: ${errorMessage(error)}`);
  }
}
