import { LOGICAL_DELETE_CONTENT_TYPE, MARKDOWN_CONTENT_TYPE } from "./index.js";
import {
  isStampEligible,
  isInternalMetadataPath,
  stampGeneration,
  stripGenerationStamp,
} from "./generationStamp.js";

export { LOGICAL_DELETE_CONTENT_TYPE } from "./index.js";

const MARKER_VERSION = "context.logical-delete.v1";
const MARKER_PREFIX = `${MARKER_VERSION}.`;
const HEX = /^[0-9a-f]{64}$/;
const MAX_RETRIES = 3;
// Delimited-prefix visibility is the one place the wrapper must look past a
// physical page. Keep that probe bounded to the same 100-page ceiling as the
// gateway's ordinary storage walks; ordinary list callers own their traversal.
const MAX_PREFIX_SCAN_PAGES = 100;
// One request may rotate a full 200-note batch. Remember only whether those
// exact versions carried a generation footer, never their text, so the
// conditional writes derived from those reads do not fetch every body twice.
const INSPECTION_CACHE_LIMIT = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MARKER_BODY_BYTES = encoder.encode(`${MARKER_PREFIX}${"0".repeat(32)}.${"0".repeat(64)}`).byteLength;

function isSafeMarkerBody(value) {
  if (typeof value !== "string" || !value.startsWith(MARKER_PREFIX)) return null;
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== "context" || parts[1] !== "logical-delete" || parts[2] !== "v1") return null;
  const [, , , nonce, previousHash] = parts;
  if (!/^[0-9a-f]{32}$/.test(nonce) || !HEX.test(previousHash)) return null;
  return { nonce, previousHash };
}

function contentTypeOf(object) {
  return object?.contentType || object?.httpMetadata?.contentType;
}

function isMarkdownContentType(value) {
  return value === undefined || value === null || value === MARKDOWN_CONTENT_TYPE;
}

function isMarkdownPath(path) {
  return typeof path === "string" && path.toLowerCase().endsWith(".md");
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

function markdownText(value) {
  if (typeof value === "string") return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? null : value;
  try {
    if (value instanceof ArrayBuffer) {
      const text = strictDecoder.decode(new Uint8Array(value));
      return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
    }
    if (ArrayBuffer.isView(value)) {
      const text = strictDecoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
    }
  } catch {
    return null;
  }
  return null;
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required for logical deletion");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else throw new Error("Web Crypto is required for logical deletion");
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function markerBody(previousEtag) {
  return `${MARKER_PREFIX}${randomNonce()}.${await sha256(previousEtag || "")}`;
}

function markerValue(value, contentType) {
  if (contentType === LOGICAL_DELETE_CONTENT_TYPE) return true;
  if ((typeof value === "string" ? value.length : value?.byteLength) !== MARKER_BODY_BYTES) return false;
  const body = typeof value === "string"
    ? value
    : decoder.decode(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  return isSafeMarkerBody(body) || contentType === LOGICAL_DELETE_CONTENT_TYPE;
}

/** Recognize a marker from its exact body, including adapters that drop MIME metadata. */
export function isLogicalDeleteMarker(value) {
  const body = typeof value === "string"
    ? value
    : decoder.decode(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  return Boolean(isSafeMarkerBody(body));
}

async function buffered(object) {
  if (object === null) return null;
  if (object.__logicalDeleteBuffered) return object;
  const bytes = object.arrayBuffer
    ? await object.arrayBuffer()
    : encoder.encode(await object.text());
  const buffer = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const text = decoder.decode(buffer);
  return {
    etag: object.etag,
    size: buffer.byteLength,
    contentType: object.contentType,
    httpMetadata: object.httpMetadata,
    __logicalDeleteBuffered: true,
    text: async () => text,
    arrayBuffer: async () => buffer,
  };
}

async function inspect(object, key) {
  if (object === null) return null;
  const contentType = contentTypeOf(object);
  // Some providers replace MIME metadata. Recognize the reserved exact body
  // too, buffering a candidate only once. A known different byte size cannot
  // be a marker and keeps native R2's lazy body untouched.
  // A provider/proxy may return a stamped Markdown object as text/plain or
  // with no MIME metadata. The footer is the generation discriminator; MIME
  // is validated only on writes, never used to hide a valid stamp.
  const stampCandidate = isMarkdownPath(key);
  if (contentType !== LOGICAL_DELETE_CONTENT_TYPE && !stampCandidate &&
      typeof object.size === "number" && object.size !== MARKER_BODY_BYTES) {
    return { object, marker: null };
  }
  const cached = await buffered(object);
  const physicalText = await cached.text();
  const marker = isSafeMarkerBody(physicalText);
  const stamped = !marker && stampCandidate ? stripGenerationStamp(physicalText) : null;
  const logical = stamped && isStampEligible(key, stamped.text) ? stamped : null;
  return { object: cached, marker, stamp: logical };
}

function logicalObject(object, stamp) {
  if (!stamp) return object;
  const bytes = encoder.encode(stamp.text);
  return {
    ...object,
    size: bytes.byteLength,
    text: async () => stamp.text,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

function unsupportedRecreation(key, value) {
  if (isInternalMetadataPath(key)) return false;
  const text = markdownText(value);
  if (!isMarkdownPath(key)) {
    throw new Error("cannot recreate an unsupported object over a logical tombstone");
  }
  if (!isStampEligible(key, text)) {
    throw new Error("cannot recreate an unsupported Markdown path over a logical tombstone");
  }
  return true;
}

function stampedWrite(key, value, options, inspected) {
  const text = markdownText(value);
  if (!inspected?.stamp) {
    // A caller may intentionally write a literal comment matching our footer
    // grammar. Wrap it in a fresh footer so the literal user text is retained
    // when the logical read strips only the outer stamp.
    if (text !== null && isStampEligible(key, text) && stripGenerationStamp(text)) {
      if (!isMarkdownContentType(options.contentType)) {
        throw new Error("cannot write unsupported content to a Markdown path");
      }
      return {
        value: stampGeneration(text),
        options: {
          ...options,
          ...(options.contentType === undefined ? { contentType: MARKDOWN_CONTENT_TYPE } : {}),
        },
      };
    }
    return { value, options };
  }
  if (!isStampEligible(key, text) || !isMarkdownContentType(options.contentType)) {
    throw new Error("cannot write unsupported content to a stamped Markdown path");
  }
  return {
    value: stampGeneration(text),
    options: {
      ...options,
      ...(options.contentType === undefined ? { contentType: MARKDOWN_CONTENT_TYPE } : {}),
    },
  };
}

async function hasVisibleObject(prefix, store) {
  try {
    let cursor;
    for (let pageNumber = 0; pageNumber < MAX_PREFIX_SCAN_PAGES; pageNumber += 1) {
      const page = await store.list({ prefix, cursor, limit: 1000 });
      for (const listed of page.objects || []) {
        if (listed.size !== undefined && listed.size !== MARKER_BODY_BYTES) return true;
        const inspected = await inspect(await store.get(listed.key), listed.key);
        if (inspected && !inspected.marker) return true;
      }
      if (!page.truncated) return false;
      if (!page.cursor || page.cursor === cursor) throw new Error("logical-delete prefix listing made no progress");
      cursor = page.cursor;
    }
    throw new Error("logical-delete prefix listing exceeded its safety bound");
  } catch (error) {
    // The parent listing already disclosed this prefix. If a provider refuses
    // to walk it (for example, an unsafe legacy key), retain the prefix rather
    // than turning one bad folder into a failed root listing or hiding it.
    if (error instanceof Error && /^unsafe storage prefix: a prefix /.test(error.message)) return true;
    throw error;
  }
}

function putOptions(options, onlyIf) {
  return { ...options, ...(onlyIf ? { onlyIf } : {}) };
}

/**
 * Provide conditional deletion for stores that can atomically CAS-write but
 * cannot atomically delete. User objects are replaced by a content-free marker;
 * the marker is hidden by this wrapper and is never physically deleted.
 */
export function withLogicalDelete(store, { logicalDelete = true } = {}) {
  if (!store) return store;
  const physicalDelete = store.capabilities?.conditionalDelete === true;
  // Read interpretation remains enabled even when a capability probe is
  // missing or later downgrades a bucket. Existing markers must stay hidden;
  // only new marker writes require both verified conditional write and create.
  const canLogicalWrite =
    store.capabilities?.conditionalWrite === true && store.capabilities?.conditionalCreate === true;
  const canWriteMarkers = logicalDelete === true && canLogicalWrite;
  let chargeExtraOperation = null;
  const inspections = new Map();
  const rememberInspection = (key, inspected) => {
    const etag = inspected?.object?.etag;
    if (inspected?.marker || typeof etag !== "string" || !etag) return;
    inspections.delete(key);
    inspections.set(key, { etag, stamped: Boolean(inspected.stamp) });
    if (inspections.size > INSPECTION_CACHE_LIMIT) {
      inspections.delete(inspections.keys().next().value);
    }
  };
  const beginRawOperation = () => {
    let first = true;
    const before = () => {
      if (first) {
        first = false;
        return;
      }
      chargeExtraOperation?.();
    };
    return {
      get(key) {
        before();
        return store.get(key);
      },
      head(key) {
        before();
        return store.head(key);
      },
      exists(key) {
        before();
        return store.exists(key);
      },
      list(options) {
        before();
        return store.list(options);
      },
      put(key, value, options) {
        before();
        return store.put(key, value, options);
      },
      delete(key, options) {
        before();
        return store.delete(key, options);
      },
    };
  };

  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store)), {
    capabilities: {
      ...store.capabilities,
      conditionalDelete: physicalDelete || canWriteMarkers,
      serverSideCopy: false,
    },
    setExtraOperationCharge(callback) {
      const previous = chargeExtraOperation;
      chargeExtraOperation = typeof callback === "function" ? callback : null;
      return () => {
        chargeExtraOperation = previous;
      };
    },
    /**
     * Physical existence without reading object bytes.
     *
     * Authorization probes deliberately use this view before they know the
     * caller may read a path. It may conservatively report a tombstone as
     * present when a provider dropped its marker metadata; the authorized
     * path can then use `exists` to resolve that ambiguity safely.
     */
    async existsMetadata(key) {
      if (typeof store.exists === "function") return Boolean(await store.exists(key));
      if (typeof store.head === "function") {
        const object = await store.head(key);
        if (object !== undefined) return object !== null;
      }
      const page = await store.list({ prefix: key, limit: 4 });
      return (page?.objects || []).some((object) => object.key === key);
    },
    ...(typeof store.removeEmptyFolder === "function"
      ? { removeEmptyFolder: store.removeEmptyFolder.bind(store) }
      : {}),

    async get(key) {
      const raw = beginRawOperation();
      const object = await raw.get(key);
      if (object === null) return object;
      const inspected = await inspect(object, key);
      if (inspected.marker) return null;
      rememberInspection(key, inspected);
      return logicalObject(inspected.object, inspected.stamp);
    },

    async exists(key) {
      const raw = beginRawOperation();
      if (typeof store.head === "function") {
        const object = await raw.head(key);
        if (object === null) return false;
        if (object === undefined) {
          // A provider without metadata support may still report a physical
          // tombstone from its ordinary existence probe. Always go through
          // the logical read in this branch so deleted notes stay hidden.
          const fallback = await raw.get(key);
          const inspected = await inspect(fallback, key);
          return inspected !== null && !inspected.marker;
        }
        if (contentTypeOf(object) === LOGICAL_DELETE_CONTENT_TYPE) return false;
        if (object.size === undefined) {
          // Unknown size is also not enough to distinguish a marker. The
          // marker-aware read is the only safe fallback when metadata is
          // incomplete or a proxy dropped it.
          const fallback = await raw.get(key);
          const inspected = await inspect(fallback, key);
          return inspected !== null && !inspected.marker;
        }
        if (object.size !== MARKER_BODY_BYTES) return true;
        const inspected = await inspect(await raw.get(key), key);
        return inspected !== null && !inspected.marker;
      }
      const object = await raw.get(key);
      const inspected = await inspect(object, key);
      return inspected !== null && !inspected.marker;
    },

    async put(key, value, options = {}) {
      const cached = inspections.get(key);
      inspections.delete(key);
      if (markerValue(value, options.contentType)) throw new Error("reserved logical-delete marker body");
      // Lifecycle records are not user Markdown generations. Their caller's
      // exact etag is already the provider CAS proof, and bypassing the
      // wrapper's marker inspection avoids a redundant read on every index,
      // audit, and rotation-progress write. User paths keep the read so a
      // stamped generation can never be replaced blindly.
      if (isInternalMetadataPath(key) && options.onlyIf?.etagMatches !== undefined && options.onlyIf?.absent !== true) {
        return store.put(key, value, options);
      }
      // `get` already inspected this exact physical version. Its etag remains
      // the provider CAS precondition, so a concurrent remote write still
      // refuses this put; the cached bit only says whether the replacement
      // needs a fresh generation footer. No customer text is retained here.
      if (
        options.onlyIf?.absent !== true &&
        typeof options.onlyIf?.etagMatches === "string" &&
        cached?.etag === options.onlyIf.etagMatches
      ) {
        const stamped = stampedWrite(key, value, options, cached.stamped ? { stamp: true } : null);
        return store.put(key, stamped.value, stamped.options);
      }
      const raw = beginRawOperation();
      const current = await raw.get(key);
      const inspected = await inspect(current, key);
      if (!inspected?.marker) {
        const stamped = stampedWrite(key, value, options, inspected);
        return raw.put(key, stamped.value, stamped.options);
      }

      if (options.onlyIf?.absent === true) {
        if (!canLogicalWrite) return null;
        unsupportedRecreation(key, value);
        const text = markdownText(value);
        const stamped = isStampEligible(key, text)
          ? (() => {
              if (!isMarkdownContentType(options.contentType)) {
                throw new Error("cannot recreate a non-Markdown object over a logical tombstone");
              }
              return { value: stampGeneration(text), options: { ...options, contentType: MARKDOWN_CONTENT_TYPE } };
            })()
          : isInternalMetadataPath(key)
            ? { value, options }
            : (() => {
                unsupportedRecreation(key, value);
                throw new Error("cannot recreate an unsupported object over a logical tombstone");
              })();
        return raw.put(key, stamped.value, putOptions(stamped.options, { etagMatches: inspected.object.etag }));
      }
      if (options.onlyIf?.etagMatches !== undefined && options.onlyIf.etagMatches !== inspected.object.etag) return null;
      // Internal lifecycle metadata has historically used unconditional puts.
      // Once its key is represented by a tombstone, preserve that API while
      // fencing the replacement against the marker generation. User paths
      // still require an explicit absent recreation to avoid reviving stale
      // writers over a logical delete.
      if (isInternalMetadataPath(key) && canLogicalWrite) {
        return raw.put(key, value, putOptions(options, { etagMatches: inspected.object.etag }));
      }
      // A caller must explicitly recreate a logically deleted path with an
      // absent precondition. Do not let an old unconditional writer overwrite
      // a generation fence.
      return null;
    },

    async delete(key, options = {}) {
      inspections.delete(key);
      const raw = beginRawOperation();
      for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
        const current = await raw.get(key);
        const inspected = await inspect(current, key);
        if (!inspected) return null;
        if (inspected.marker) {
          const expected = options.onlyIf?.etagMatches;
          if (expected === undefined || expected === inspected.object.etag || (await sha256(expected)) === inspected.marker.previousHash) return;
          return null;
        }
        const expected = options.onlyIf?.etagMatches;
        if (expected !== undefined && expected !== inspected.object.etag) return null;
        if (!canWriteMarkers) {
          // Preserve the provider's existing behavior for ordinary objects.
          // Its advertised capability remains false when not verified; core
          // lifecycle operations refuse it. Existing markers never reach here.
          return raw.delete?.(key, options);
        }
        const body = await markerBody(inspected.object.etag);
        const written = await raw.put(key, body, putOptions({ contentType: LOGICAL_DELETE_CONTENT_TYPE }, {
          etagMatches: inspected.object.etag,
        }));
        if (written) return;
        if (expected !== undefined) return null;
      }
      return null;
    },

    async list(options = {}) {
      const raw = beginRawOperation();
      const objects = [];
      const delimitedPrefixes = [];
      const seenPrefixes = new Set();
      // Preserve the provider's page boundary. Fetching more physical pages
      // here used to fill a caller's limit after hiding markers, which silently
      // consumed its pagination budget and could drop a cursor's tail. An
      // empty filtered page is meaningful: callers must follow its cursor.
      const page = await raw.list(options);
      for (const listed of page.objects || []) {
        if (listed.size !== undefined && listed.size !== MARKER_BODY_BYTES) {
          objects.push(listed);
        } else {
          const object = await raw.get(listed.key);
          const inspected = await inspect(object, listed.key);
          if (inspected && !inspected.marker) objects.push(listed);
        }
      }
      for (const prefix of page.delimitedPrefixes || []) {
        if (seenPrefixes.has(prefix) || !(await hasVisibleObject(prefix, raw))) continue;
        seenPrefixes.add(prefix);
        delimitedPrefixes.push(prefix);
      }
      return {
        ...page,
        objects,
        ...(page.delimitedPrefixes === undefined ? {} : { delimitedPrefixes }),
      };
    },

    async copy(source, destination, options = {}) {
      const object = await this.get(source);
      if (!object) return null;
      if (options.sourceOnlyIf?.etagMatches !== undefined &&
          options.sourceOnlyIf.etagMatches !== object.etag) return null;
      const body = object.arrayBuffer ? await object.arrayBuffer() : await object.text();
      return this.put(destination, body, {
        ...options,
        ...(options.contentType === undefined && object.contentType !== undefined
          ? { contentType: object.contentType }
          : {}),
      });
    },
  });
  return wrapped;
}
