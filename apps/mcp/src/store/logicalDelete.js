import { LOGICAL_DELETE_CONTENT_TYPE } from "./index.js";

export { LOGICAL_DELETE_CONTENT_TYPE } from "./index.js";

const MARKER_VERSION = "context.logical-delete.v1";
const MARKER_PREFIX = `${MARKER_VERSION}.`;
const HEX = /^[0-9a-f]{64}$/;
const MAX_RETRIES = 3;
const MAX_LIST_PAGES = 1000;

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

async function inspect(object) {
  if (object === null) return null;
  const contentType = contentTypeOf(object);
  // Some providers replace MIME metadata. Recognize the reserved exact body
  // too, buffering a candidate only once. A known different byte size cannot
  // be a marker and keeps native R2's lazy body untouched.
  if (contentType !== LOGICAL_DELETE_CONTENT_TYPE &&
      typeof object.size === "number" && object.size !== MARKER_BODY_BYTES) {
    return { object, marker: null };
  }
  const cached = await buffered(object);
  return { object: cached, marker: isSafeMarkerBody(await cached.text()) };
}

async function hasVisibleObject(prefix, store) {
  let cursor;
  for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
    const page = await store.list({ prefix, cursor, limit: 1000 });
    for (const listed of page.objects || []) {
      if (listed.size !== undefined && listed.size !== MARKER_BODY_BYTES) return true;
      const inspected = await inspect(await store.get(listed.key));
      if (inspected && !inspected.marker) return true;
    }
    if (!page.truncated) return false;
    if (!page.cursor || page.cursor === cursor) throw new Error("logical-delete prefix listing made no progress");
    cursor = page.cursor;
  }
  throw new Error("logical-delete prefix listing exceeded its safety bound");
}

function putOptions(options, onlyIf) {
  return { ...options, ...(onlyIf ? { onlyIf } : {}) };
}

/**
 * Provide conditional deletion for stores that can atomically CAS-write but
 * cannot atomically delete. User objects are replaced by a content-free marker;
 * the marker is hidden by this wrapper and is never physically deleted.
 */
export function withLogicalDelete(store, { logicalDelete = store?.capabilities?.conditionalDelete !== true } = {}) {
  if (!store) return store;
  const physicalDelete = store.capabilities?.conditionalDelete === true;
  // Read interpretation remains enabled even when a capability probe is
  // missing or later downgrades a bucket. Existing markers must stay hidden;
  // only new marker writes require both verified conditional write and create.
  const canLogicalWrite =
    store.capabilities?.conditionalWrite === true && store.capabilities?.conditionalCreate === true;
  const canWriteMarkers = logicalDelete === true && canLogicalWrite;

  const rawGet = (key) => store.get(key);

  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store)), {
    capabilities: {
      ...store.capabilities,
      conditionalDelete: physicalDelete || canWriteMarkers,
      serverSideCopy: false,
    },

    async get(key) {
      const object = await rawGet(key);
      if (object === null) return object;
      const inspected = await inspect(object);
      return inspected.marker ? null : inspected.object;
    },

    async exists(key) {
      if (typeof store.exists !== "function") return (await this.get(key)) !== null;
      return (await this.get(key)) !== null;
    },

    async put(key, value, options = {}) {
      if (markerValue(value, options.contentType)) throw new Error("reserved logical-delete marker body");
      const current = await rawGet(key);
      const inspected = await inspect(current);
      if (!inspected?.marker) return store.put(key, value, options);

      if (options.onlyIf?.absent === true) {
        if (!canLogicalWrite) return null;
        return store.put(key, value, putOptions(options, { etagMatches: inspected.object.etag }));
      }
      if (options.onlyIf?.etagMatches !== undefined && options.onlyIf.etagMatches !== inspected.object.etag) return null;
      // A caller must explicitly recreate a logically deleted path with an
      // absent precondition. Do not let an old unconditional writer overwrite
      // a generation fence.
      return null;
    },

    async delete(key, options = {}) {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
        const current = await rawGet(key);
        const inspected = await inspect(current);
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
          return store.delete?.(key, options);
        }
        const body = await markerBody(inspected.object.etag);
        const written = await store.put(key, body, putOptions({ contentType: LOGICAL_DELETE_CONTENT_TYPE }, {
          etagMatches: inspected.object.etag,
        }));
        if (written) return;
        if (expected !== undefined) return null;
      }
      return null;
    },

    async list(options = {}) {
      const objects = [];
      const delimitedPrefixes = [];
      const seenPrefixes = new Set();
      let cursor = options.cursor;
      let page = null;
      let finished = false;
      for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
        page = await store.list({ ...options, ...(cursor === undefined ? {} : { cursor }) });
        for (const listed of page.objects || []) {
          if (listed.size !== undefined && listed.size !== MARKER_BODY_BYTES) {
            objects.push(listed);
          } else {
            const object = await rawGet(listed.key);
            const inspected = await inspect(object);
            if (inspected && !inspected.marker) objects.push(listed);
          }
        }
        for (const prefix of page.delimitedPrefixes || []) {
          if (seenPrefixes.has(prefix) || !(await hasVisibleObject(prefix, store))) continue;
          seenPrefixes.add(prefix);
          delimitedPrefixes.push(prefix);
        }
        // Return the complete filtered physical page with that page's cursor.
        // Filling a limit from the next page would discard its unreturned tail.
        if (objects.length > 0 || delimitedPrefixes.length > 0 || !page.truncated) {
          finished = true;
          break;
        }
        if (!page.cursor || page.cursor === cursor) throw new Error("logical-delete listing made no progress");
        cursor = page.cursor;
      }
      if (!finished || page === null) throw new Error("logical-delete listing exceeded its safety bound");
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
