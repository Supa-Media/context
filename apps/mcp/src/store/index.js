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

/**
 * An etag is about to be interpolated into an `If-Match` header. RFC 7232
 * allows `%x21 / %x23-7E` inside an entity-tag, which excludes the quote we add
 * ourselves and every control character — so a CR/LF can never split the header
 * and a quote can never terminate it early.
 */
export function assertSafeEtag(value) {
  if (typeof value !== "string" || !value || value.length > MAX_ETAG_LENGTH) {
    throw new Error("unsafe etag: an etag must be a non-empty string of at most 256 characters");
  }
  if (!/^[\x21\x23-\x7e]+$/.test(value)) {
    throw new Error("unsafe etag: an etag must not contain quotes, control characters, or non-ASCII");
  }
  return value;
}

/**
 * What a stored object may be written as.
 *
 * **An enumeration, never free text, and that is a security property rather
 * than tidiness.** The chosen value is interpolated straight into S3's
 * `content-type` request header, so a caller-supplied string is header
 * injection by the same route `assertSafeEtag` exists to close one function
 * above. An allow-list means there is no string an attacker can reach this
 * with at all.
 *
 * Markdown is the default and stays the default: a `put` that names nothing
 * behaves exactly as every `put` in this codebase did before this map existed,
 * so adding it changes no existing write.
 *
 * The image types are the ones `read_image` will hand back
 * (`IMAGE_MIME_TYPES` in `src/index.js`). Writing a type the gateway cannot
 * serve would put bytes in a customer's bucket that nothing can ever read out
 * — and **SVG is deliberately absent from both**: it is a script container, and
 * the gateway refuses to serve one for that reason. A store that would accept
 * it is a store that makes the refusal moot.
 */
export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export const WRITABLE_CONTENT_TYPES = new Set([
  MARKDOWN_CONTENT_TYPE,
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/**
 * The content type for a write, or a throw.
 *
 * Absent means markdown, which is what every caller predating this meant.
 * Anything not in the set is refused rather than sanitised: a sanitiser is a
 * guess about a header grammar, and there is no reason to accept a type the
 * gateway could not serve back.
 */
export function assertWritableContentType(value) {
  if (value === undefined || value === null) return MARKDOWN_CONTENT_TYPE;
  if (typeof value !== "string" || !WRITABLE_CONTENT_TYPES.has(value)) {
    throw new Error(
      "unsupported content type: a stored object must be markdown or an image type the gateway can serve",
    );
  }
  return value;
}

const MAX_ETAG_LENGTH = 256;
/** S3 caps object keys at 1024 characters; anything longer is a bug or an attack. */
const MAX_KEY_LENGTH = 1024;
/** NUL and other control characters, plus the backslash some backends fold to "/". */
const FORBIDDEN_KEY_CHARS = /[\u0000-\u001f\u007f\\]/;

function decodeSegment(segment) {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape stays literal; it is encoded again on the way out.
    return segment;
  }
}

/**
 * Why the adapter validates at all: `encodeRfc3986` does not encode "." (it is
 * RFC 3986 unreserved), so a literal ".." survives encoding and the WHATWG URL
 * parser removes dot segments when `url.pathname` is assigned — silently
 * rewriting the key, escaping the rootPrefix, and even dropping the bucket
 * segment. The signature is computed after that rewrite, so the request is
 * valid, correctly signed, and pointed somewhere the caller never asked for.
 * Reject instead of normalizing: a caller that meant "a/../b.md" has a bug.
 */
function describeKeyProblem(key, { allowTrailingSlash }) {
  if (typeof key !== "string") return "must be a string";
  if (!key) return "must not be empty";
  if (key.length > MAX_KEY_LENGTH) return `must be at most ${MAX_KEY_LENGTH} characters`;
  if (FORBIDDEN_KEY_CHARS.test(key)) return "must not contain control characters or backslashes";
  const segments = key.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;
    if (segment === "") {
      if (isLast && allowTrailingSlash && segments.length > 1) continue;
      return "must not contain an empty path segment";
    }
    const decoded = decodeSegment(segment);
    if (segment === "." || decoded === ".") return 'must not contain a "." path segment';
    if (segment === ".." || decoded === "..") return 'must not contain a ".." path segment';
  }
  return null;
}

/**
 * Guard an object key at the adapter boundary, so `S3Store` and `R2Store` agree
 * on exactly which keys are addressable. The message never echoes the key:
 * keys are the customer's own note paths and gateway logs do not carry them.
 */
export function assertSafeKey(key) {
  const problem = describeKeyProblem(key, { allowTrailingSlash: false });
  if (problem) throw new Error(`unsafe storage key: a key ${problem}`);
  return key;
}

/** Same rules as a key, but "" means the whole bucket and a trailing "/" is normal. */
export function assertSafePrefix(prefix) {
  if (prefix === undefined || prefix === null || prefix === "") return "";
  const problem = describeKeyProblem(prefix, { allowTrailingSlash: true });
  if (problem) throw new Error(`unsafe storage prefix: a prefix ${problem}`);
  return prefix;
}

/**
 * "" or a prefix guaranteed to end in exactly one "/".
 *
 * Validated like any other prefix: a rootPrefix is configuration, but it is
 * still a path, and `".."` in it would escape the bucket on every request.
 */
export function normalizeRootPrefix(value) {
  if (!value) return "";
  const trimmed = String(value).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return "";
  assertSafePrefix(trimmed);
  return `${trimmed}/`;
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

/**
 * Re-key a backend list page into caller-visible keys.
 *
 * One honest exception to "nothing above the adapter sees the rootPrefix":
 * `page.cursor` is passed through verbatim, and an S3 continuation token is
 * base64 of the last backend key — prefix included. It is not rewritten
 * because it is an opaque token the same adapter must hand back to the same
 * backend unchanged; re-encoding it would only obfuscate. It is safe because
 * the cursor never escapes the pagination loops in `src/index.js`: it is never
 * returned by a tool, never logged, and never stored. If a cursor ever becomes
 * caller-visible, that claim has to be re-examined.
 */
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
 * *actually* enforced. Both halves of the contract are tested, because either
 * one alone passes backends that corrupt notes in production:
 *
 * 1. **A wrong `If-Match` must be rejected.** A backend that accepts it has no
 *    conflict detection at all — every conflict-safe write silently becomes
 *    last-writer-wins.
 * 2. **A correct `If-Match` must be accepted.** A backend that 412s *every*
 *    `If-Match` passes step 1, and then makes every visibility change fail
 *    with "changed concurrently" after five useless retries.
 * 3. **A now-stale but well-formed `If-Match` must be rejected.** A backend
 *    that only validates the *shape* of an etag passes steps 1 and 2, then
 *    does last-writer-wins on a real conflict: two concurrent
 *    `set_visibility` calls lose one, and a note meant to be private stays
 *    team-readable.
 *
 * `conditionalWrite.verified` is true only when all three hold.
 *
 * Never throws, and never reports a capability it did not observe. The temp
 * object is cleaned up; `cleanedUp: false` says it was left behind.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   reachable: boolean,
 *   writable: boolean,
 *   capabilities: { conditionalWrite: boolean },
 *   conditionalWrite: {
 *     declared: boolean,
 *     verified: boolean,
 *     rejectsWrong: boolean,
 *     acceptsCorrect: boolean,
 *     rejectsStale: boolean,
 *     mismatch: boolean,
 *     detail: string,
 *   },
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
    conditionalWrite: {
      declared,
      verified: false,
      rejectsWrong: false,
      acceptsCorrect: false,
      rejectsStale: false,
      mismatch: declared,
      detail: "not tested",
    },
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
  const conditionalOverwrite = "context store capability probe — a correct If-Match must land";
  const staleOverwrite = "context store capability probe — a stale If-Match must not land";
  let realEtag = null;
  try {
    const written = await store.put(key, original);
    result.writable = Boolean(written && written.etag);
    realEtag = written?.etag || null;
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
      result.conditionalWrite.rejectsWrong = true;
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

  // Rejecting a wrong etag proves nothing on its own: a backend can 412 the
  // malformed probe etag — or every etag — without ever comparing a real one.
  // The correct etag must therefore be accepted...
  if (result.conditionalWrite.rejectsWrong) {
    try {
      const accepted = await store.put(key, conditionalOverwrite, {
        onlyIf: { etagMatches: realEtag },
      });
      if (accepted && accepted.etag) {
        if ((await readProbe(store, key)) === conditionalOverwrite) {
          result.conditionalWrite.acceptsCorrect = true;
          result.conditionalWrite.detail =
            "a wrong If-Match was rejected and a correct one was accepted";
        } else {
          result.conditionalWrite.detail =
            "the store reported success for a correct If-Match whose write did not land";
          result.errors.push("conditional write reports success without writing");
        }
      } else {
        // Passes the rejection half and fails every real conflict-safe write:
        // in production every retry loop exhausts and throws.
        result.conditionalWrite.detail =
          "the store rejected a correct If-Match; every conflict-safe write would fail";
        result.errors.push("conditional write rejects a correct precondition");
      }
    } catch (error) {
      result.conditionalWrite.detail = `a correct If-Match raised instead of writing: ${errorMessage(error)}`;
      result.errors.push("conditional write raised on a correct precondition");
    }
  }

  // ...and the etag that was correct a moment ago must now be refused. This is
  // the mode the first two steps cannot see: a backend that only validates the
  // *shape* of an etag passes both, then silently does last-writer-wins on a
  // real stale precondition — exactly the concurrent `set_visibility` loss the
  // probe exists to prevent.
  if (result.conditionalWrite.acceptsCorrect) {
    try {
      const stale = await store.put(key, staleOverwrite, {
        onlyIf: { etagMatches: realEtag },
      });
      if (stale === null || stale === undefined) {
        result.conditionalWrite.rejectsStale = true;
        result.conditionalWrite.detail =
          "wrong, correct, and stale If-Match preconditions all behaved correctly";
      } else if ((await readProbe(store, key)) === staleOverwrite) {
        result.conditionalWrite.detail =
          "the store accepted a stale If-Match; it checks etag shape, not the object";
        result.errors.push("conditional write does not detect a real conflict");
      } else {
        result.conditionalWrite.detail =
          "the store reported success for a stale If-Match whose write did not land; conflicts are not reportable";
        result.errors.push("conditional write does not report a real conflict");
      }
    } catch (error) {
      result.conditionalWrite.detail = `a stale If-Match raised instead of returning null: ${errorMessage(error)}`;
      result.errors.push("conditional write did not return null on a stale precondition");
    }
  }

  result.conditionalWrite.verified =
    result.conditionalWrite.rejectsWrong &&
    result.conditionalWrite.acceptsCorrect &&
    result.conditionalWrite.rejectsStale;

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
