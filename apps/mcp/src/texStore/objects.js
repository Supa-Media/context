/**
 * Tex's notes, kept in a Durable Object's own SQLite (decided by the owner,
 * 2026-10-31: "durable object per personal tex and group tex";
 * `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * The objects one Durable Object holds, shaped like an R2 bucket's so the
 * gateway's store adapter (`store/r2.js`) can sit on top unchanged: keys,
 * etags, content type and custom metadata, conditional writes, prefix
 * listings with a delimiter. Bodies are split into chunks, because one SQLite
 * value in a Durable Object is at most 2 MB.
 *
 * Pure over a `sql` with the Durable Object's shape (`exec(query, ...binds)`
 * returning a cursor with `toArray()`), so the Node tests run it against
 * `node:sqlite` and the Durable Object (`texStore.js`) runs it as it is.
 */

/** One stored value; under the Durable Object's 2 MB per value. */
export const CHUNK_BYTES = 1024 * 1024;
/** The largest object kept: a picture or a long transcript fits; a video does not. */
export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
/** The most keys one listing page returns, as R2's own cap. */
export const MAX_LIST = 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS objects (
    key TEXT PRIMARY KEY,
    etag TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded INTEGER NOT NULL,
    content_type TEXT,
    custom TEXT,
    chunks INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chunks (
    key TEXT NOT NULL,
    n INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (key, n)
  )`,
];

/** A store write the object refuses: too large, or a key it would not keep. */
export class TexObjectRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "TexObjectRefused";
  }
}

const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

function checkKey(key) {
  if (typeof key !== "string" || key === "" || key.length > 1024 || key.startsWith("/") || key.includes("\0")) {
    throw new TexObjectRefused("not a key this store keeps");
  }
  return key;
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value === null || value === undefined) return new Uint8Array(0);
  throw new TexObjectRefused("a body this store reads whole: bytes or text");
}

async function etagOf(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function metaOf(row) {
  return {
    key: row.key,
    etag: row.etag,
    size: Number(row.size),
    uploaded: Number(row.uploaded),
    httpMetadata: row.content_type ? { contentType: row.content_type } : {},
    customMetadata: row.custom ? JSON.parse(row.custom) : {},
  };
}

/** Whether `meta` (or no object, `null`) passes R2's `onlyIf` as given. */
function passes(meta, onlyIf) {
  if (!onlyIf || typeof onlyIf !== "object") return true;
  const { etagMatches, etagDoesNotMatch } = onlyIf;
  if (typeof etagMatches === "string") {
    if (meta === null) return false;
    if (etagMatches !== "*" && etagMatches.replace(/"/g, "") !== meta.etag) return false;
  }
  if (typeof etagDoesNotMatch === "string") {
    if (etagDoesNotMatch === "*") return meta === null;
    if (meta !== null && etagDoesNotMatch.replace(/"/g, "") === meta.etag) return false;
  }
  return true;
}

/**
 * The objects over one Durable Object's `sql`.
 *
 * @param {{exec: (query: string, ...binds: unknown[]) => {toArray(): object[]}}} sql
 * @param {{now?: () => number, guard?: () => void}} [options] `guard` runs
 *   synchronously right before every write, and throws to stop it: an object
 *   that has moved (`move.js`) keeps no write.
 */
export function texObjects(sql, { now = Date.now, guard = () => {} } = {}) {
  for (const statement of SCHEMA) sql.exec(statement);

  const metaRow = (key) => rows(sql.exec("SELECT * FROM objects WHERE key = ?", key))[0] ?? null;

  function bodyOf(row, range) {
    const parts = rows(sql.exec("SELECT data FROM chunks WHERE key = ? ORDER BY n", row.key)).map((part) => bytesOf(part.data));
    const whole = new Uint8Array(Number(row.size));
    let at = 0;
    for (const part of parts) {
      whole.set(part, at);
      at += part.byteLength;
    }
    if (!range) return whole;
    const size = whole.byteLength;
    if (Number.isFinite(range.suffix)) return whole.slice(Math.max(0, size - range.suffix));
    const offset = Number.isFinite(range.offset) ? range.offset : 0;
    const end = Number.isFinite(range.length) ? offset + range.length : size;
    return whole.slice(offset, end);
  }

  function remove(key) {
    sql.exec("DELETE FROM chunks WHERE key = ?", key);
    sql.exec("DELETE FROM objects WHERE key = ?", key);
  }

  return {
    /** Metadata only, or `null`. */
    head(key) {
      const row = metaRow(checkKey(key));
      return row ? metaOf(row) : null;
    },

    /**
     * `{...meta, body}`; `{...meta}` with no body when `onlyIf` fails (as R2
     * answers); `null` when there is none.
     */
    get(key, options = {}) {
      const row = metaRow(checkKey(key));
      if (!row) return null;
      const meta = metaOf(row);
      if (!passes(meta, options.onlyIf)) return meta;
      return { ...meta, body: bodyOf(row, options.range) };
    },

    /** The new object's metadata, or `null` when `onlyIf` failed and nothing was written. */
    async put(key, value, options = {}) {
      checkKey(key);
      const bytes = bytesOf(value);
      if (bytes.byteLength > MAX_OBJECT_BYTES) throw new TexObjectRefused(`larger than ${MAX_OBJECT_BYTES} bytes`);
      const etag = await etagOf(bytes);
      const existing = metaRow(key);
      if (!passes(existing ? metaOf(existing) : null, options.onlyIf)) return null;
      const contentType = options.httpMetadata?.contentType ?? null;
      const custom = options.customMetadata && Object.keys(options.customMetadata).length > 0 ? JSON.stringify(options.customMetadata) : null;
      // An empty body keeps no chunk: SQLite stores an empty blob as NULL.
      const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
      // One Durable Object runs one request's synchronous code at a time, so
      // the check above and these writes cannot interleave with another put.
      guard();
      remove(key);
      for (let n = 0; n < count; n += 1) {
        sql.exec("INSERT INTO chunks (key, n, data) VALUES (?, ?, ?)", key, n, bytes.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES));
      }
      const uploaded = now();
      sql.exec(
        "INSERT INTO objects (key, etag, size, uploaded, content_type, custom, chunks) VALUES (?, ?, ?, ?, ?, ?, ?)",
        key,
        etag,
        bytes.byteLength,
        uploaded,
        contentType,
        custom,
        count,
      );
      return metaOf({ key, etag, size: bytes.byteLength, uploaded, content_type: contentType, custom });
    },

    /** Removes each key given; a missing one is not an error, as in R2. */
    delete(keys) {
      guard();
      for (const key of Array.isArray(keys) ? keys : [keys]) remove(checkKey(key));
    },

    /**
     * One page of keys in order, as R2 lists: `{objects, truncated, cursor?,
     * delimitedPrefixes}`. The cursor is the last key returned.
     */
    list({ prefix = "", delimiter, cursor, startAfter, limit } = {}) {
      const size = Math.min(MAX_LIST, Number.isInteger(limit) && limit > 0 ? limit : MAX_LIST);
      const after = typeof cursor === "string" && cursor !== "" ? cursor : typeof startAfter === "string" ? startAfter : "";
      const objects = [];
      const prefixes = [];
      let last = after;
      let truncated = false;
      // Read in batches, so a delimiter folding many keys into one prefix never stops a page early.
      for (;;) {
        const batch = rows(
          sql.exec(
            "SELECT * FROM objects WHERE key > ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?",
            last,
            prefix.length,
            prefix,
            size + 1,
          ),
        );
        for (const row of batch) {
          if (objects.length + prefixes.length >= size) {
            truncated = true;
            break;
          }
          last = row.key;
          const rest = row.key.slice(prefix.length);
          const cut = typeof delimiter === "string" && delimiter !== "" ? rest.indexOf(delimiter) : -1;
          if (cut >= 0) {
            const folded = prefix + rest.slice(0, cut + delimiter.length);
            if (prefixes[prefixes.length - 1] !== folded) prefixes.push(folded);
            // Skip every key under this prefix in one step.
            last = `${folded}\u{10ffff}`;
            continue;
          }
          objects.push(metaOf(row));
        }
        if (truncated || batch.length <= size) break;
      }
      return { objects, delimitedPrefixes: prefixes, truncated, ...(truncated ? { cursor: last } : {}) };
    },

    /** Everything this object keeps, removed. */
    wipe() {
      guard();
      sql.exec("DELETE FROM chunks");
      sql.exec("DELETE FROM objects");
    },

    /**
     * One object copied in as another Tex store kept it (`move.js`): the same
     * bytes, etag, time and metadata. Refused when the bytes are not the ones
     * the etag names, so a copy cut short or garbled is never kept.
     */
    async restore(meta, value) {
      const key = checkKey(meta?.key);
      const bytes = bytesOf(value);
      if (bytes.byteLength !== Number(meta.size) || (await etagOf(bytes)) !== meta.etag) throw new TexObjectRefused("a copied object whose bytes are not its etag's");
      guard();
      const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
      remove(key);
      for (let n = 0; n < count; n += 1) {
        sql.exec("INSERT INTO chunks (key, n, data) VALUES (?, ?, ?)", key, n, bytes.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES));
      }
      const contentType = meta.httpMetadata?.contentType ?? null;
      const custom = meta.customMetadata && Object.keys(meta.customMetadata).length > 0 ? JSON.stringify(meta.customMetadata) : null;
      sql.exec(
        "INSERT INTO objects (key, etag, size, uploaded, content_type, custom, chunks) VALUES (?, ?, ?, ?, ?, ?, ?)",
        key,
        meta.etag,
        bytes.byteLength,
        Number(meta.uploaded),
        contentType,
        custom,
        count,
      );
    },
  };
}
