/**
 * DropboxStore — a ContextStore over a folder in somebody's Dropbox.
 *
 * The same contract `S3Store` and `R2Store` implement, so nothing above this
 * file learns which backend a workspace is bound to. Keys stay the customer's
 * own note paths; the folder they chose is a `rootPrefix` applied here and
 * invisible above.
 *
 * ## Why Dropbox is not a lowest-common-denominator backend
 *
 * The obvious assumption is that a consumer sync product cannot do conditional
 * writes and this adapter has to report `conditionalWrite: false` and degrade.
 * It does not. `files/upload` takes `mode: {".tag":"update", update: <rev>}`,
 * which writes only if the file is still at that revision and returns a
 * `conflict` error if somebody moved underneath you — optimistic concurrency
 * by another name. **`rev` is this backend's etag**, and it is a better one
 * than S3's: S3 etags are content hashes, so two writes of identical bytes are
 * indistinguishable, while a `rev` changes on every write.
 *
 * Obsidian's Remotely Save syncs to both Dropbox and S3, collects `rev` and
 * `etag` into its metadata, and then never reads either — it compares mtime
 * and size against a local sync database instead, so two devices writing at
 * once is a last-writer-wins race it cannot see. That is a reasonable design
 * for a plugin that lives on one machine, and the wrong one here: this gateway
 * sits *between* clients, so the precondition costs one field and turns a
 * silent overwrite into a `null` the caller already knows how to handle.
 *
 * ## What is genuinely different from S3, and handled
 *
 *  - **Paths, not a keyspace.** Dropbox wants `/folder/file.md`; a key here is
 *    `folder/file.md`. Folders are real, so `list` maps cleanly onto
 *    `list_folder` and there is no need to synthesise directories the way an
 *    S3 adapter must.
 *  - **A missing path is a 409, not a 404.** Dropbox answers "no such file"
 *    with HTTP 409 and a tagged error body, so status alone cannot be trusted;
 *    the tag is what is read.
 *  - **Rate limits are normal, not exceptional.** 429 carries `Retry-After`
 *    and is retried with jitter, because a context sync is many small files and
 *    a thundering retry is how one slow sync becomes an outage.
 *  - **Case-insensitive, Unicode-folding paths.** Dropbox treats `Foo.md` and
 *    `foo.md` as the same file and normalises Unicode. Nothing here tries to
 *    paper over that: the keys this product writes are already normalised, and
 *    a store that silently re-cased a caller's key would be worse than one that
 *    returns what Dropbox actually has.
 */

import {
  applyRootPrefix,
  assertSafeEtag,
  assertSafeKey,
  assertSafePrefix,
  normalizeEtag,
  normalizeRootPrefix,
  stripListResult,
} from "./index.js";

const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

/**
 * Dropbox rejects a `Dropbox-API-Arg` header containing anything outside
 * ASCII, because it is a JSON document smuggled through an HTTP header. Their
 * own docs prescribe escaping the rest — so a note whose name carries an emoji
 * or an accent works here rather than being refused.
 */
function apiArgHeader(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Backoff for a 429, in milliseconds, jittered so a fleet does not sync in lockstep. */
const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000];

/**
 * The longest `Retry-After` we will actually sleep for, per attempt.
 *
 * Dropbox's number wins over ours when it is larger — but only up to here.
 * It is a value from outside the Worker, it is honoured up to four times, and
 * an unbounded one is a request that never returns: `Retry-After: 86400` asks
 * for 96 hours of wall clock across the four attempts. Past the cap the right
 * answer is to give the caller the 429 and let them come back.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Error bodies are read with a ceiling, for the reason `s3.js` gives: a
 * response body is buffered whole before anything trims it, and a hostile or
 * broken endpoint could stream hundreds of megabytes into a 128 MB isolate.
 * Milder here than there — these hosts are hardcoded constants rather than a
 * customer-configured endpoint — but the same read, and the decision was
 * already made once.
 */
const ERROR_RESPONSE_BYTE_CAP = 64_000;

async function readCappedText(response, cap) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return "";
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text().catch(() => "");
    return new TextEncoder().encode(text).byteLength > cap ? "" : text;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return "";
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * The tags out of a Dropbox error body, as a `/`-joined path — `path/not_found`,
 * `path/conflict/file`, `path/conflict/folder`.
 *
 * Reading the *tag* is the whole point, and it used to be a `String.includes`
 * over the raw body. That body also carries `error_summary` and a localized,
 * human-facing `user_message`, so a note whose prose happened to contain
 * "not_found" — or a `restricted_content` refusal whose message did — reported
 * as absent. A file that exists and cannot be read is not a file that is gone,
 * and the two answers lead to opposite places.
 *
 * Unparseable or untagged bodies yield "", which every caller treats as "not
 * the specific thing I was asking about" and therefore as a real failure.
 */
async function errorTagPath(response) {
  let parsed;
  try {
    parsed = JSON.parse(await readCappedText(response, ERROR_RESPONSE_BYTE_CAP));
  } catch {
    return "";
  }
  const tags = [];
  let node = parsed?.error;
  while (node && typeof node === "object") {
    const tag = node[".tag"];
    if (typeof tag !== "string") break;
    tags.push(tag);
    // Dropbox nests the detail under a key named after the tag, and puts an
    // upload's cause under `reason`.
    node = node[tag] ?? node.reason;
  }
  return tags.join("/");
}

export class DropboxStore {
  /**
   * @param {Object} options
   * @param {string} options.accessToken a short-lived Dropbox OAuth access token
   * @param {string} [options.rootPrefix] the folder the customer chose
   * @param {typeof fetch} [options.fetch] injected for tests
   * @param {(ms: number) => Promise<void>} [options.sleep] injected for tests
   */
  constructor(options = {}) {
    if (!options.accessToken || typeof options.accessToken !== "string") {
      throw new Error("DropboxStore requires an accessToken");
    }
    this.accessToken = options.accessToken;
    this.rootPrefix = normalizeRootPrefix(options.rootPrefix);
    this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Not a claim taken on faith anywhere: `probeStore()` still proves it at
    // connect time, exactly as it does for a backend that lies.
    this.capabilities = { conditionalWrite: true };
  }

  /** Caller key → Dropbox path. Dropbox wants a leading slash; "" is the root. */
  _path(key) {
    const scoped = applyRootPrefix(this.rootPrefix, key);
    return scoped ? `/${scoped}` : "";
  }

  /** Dropbox path → caller key, before `stripListResult` removes the rootPrefix. */
  _key(path) {
    return typeof path === "string" && path.startsWith("/") ? path.slice(1) : path;
  }

  async _request(url, init, { retriesLeft = RETRY_BACKOFF_MS.length } = {}) {
    const response = await this.fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${this.accessToken}` },
    });

    if (response.status !== 429) return response;
    if (retriesLeft <= 0) return response;

    // Dropbox tells you how long to wait; its number wins over ours when it is
    // larger, and the wait is jittered inside the window so a fleet of workers
    // does not all come back at the same instant.
    const attempt = RETRY_BACKOFF_MS.length - retriesLeft;
    const fallback = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
    const advertised = Number(response.headers.get("Retry-After")) * 1000;
    const honoured = Number.isFinite(advertised) ? Math.min(advertised, MAX_RETRY_AFTER_MS) : 0;
    // Past the cap, hand back the 429 rather than sleeping through it.
    if (Number.isFinite(advertised) && advertised > MAX_RETRY_AFTER_MS) return response;
    const base = Math.max(honoured, fallback);
    await this.sleep(base + Math.floor(Math.random() * 1000));
    return this._request(url, init, { retriesLeft: retriesLeft - 1 });
  }

  async _rpc(endpoint, body) {
    return this._request(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * Dropbox reports "no such path" as HTTP 409 with a tagged body, not a 404,
   * so the tag is what decides. Anything else 409-shaped is a real failure and
   * must not be mistaken for absence — reading a tag rather than a status is
   * the difference between "this file is missing" and "this token expired".
   */
  async _isNotFound(response) {
    if (response.status !== 409) return false;
    return (await errorTagPath(response.clone())).split("/").includes("not_found");
  }

  /**
   * The tag, and never the body.
   *
   * These throws reach the connected AI client as `internal error: <message>`,
   * and a Dropbox error body echoes the offending path — which is the
   * customer's chosen folder plus the note's own name. `assertSafeKey` states
   * the rule this has to keep ("the message never echoes the key: keys are the
   * customer's own note paths"), and `s3Error` keeps it by extracting only the
   * code. A tag is a fixed identifier from Dropbox's own vocabulary, so it can
   * say what went wrong without saying what it went wrong *on*.
   */
  async _fail(response, action) {
    const tag = await errorTagPath(response);
    throw new Error(
      `dropbox ${action} failed: ${response.status}${tag ? ` (${tag})` : ""}`,
    );
  }

  async get(key) {
    assertSafeKey(key);
    const response = await this._request(`${CONTENT_BASE}/files/download`, {
      method: "POST",
      headers: { "Dropbox-API-Arg": apiArgHeader({ path: this._path(key) }) },
    });

    if (response.status === 409 && (await this._isNotFound(response))) return null;
    if (!response.ok) return this._fail(response, "download");

    const metadata = JSON.parse(response.headers.get("Dropbox-API-Result") || "{}");
    const buffer = await response.arrayBuffer();
    return {
      etag: normalizeEtag(metadata.rev),
      text: async () => new TextDecoder().decode(buffer),
      arrayBuffer: async () => buffer,
    };
  }

  async put(key, value, options) {
    assertSafeKey(key);

    // Same refusal as R2Store and S3Store: an `onlyIf` with no usable etag is a
    // conditional write silently downgraded to an overwrite, which is the exact
    // failure this adapter exists to make impossible.
    let mode = { ".tag": "overwrite" };
    let conditional = false;
    if (options && "onlyIf" in options) {
      const expected = options.onlyIf?.etagMatches;
      if (typeof expected !== "string" || !expected.trim()) {
        throw new Error(
          "onlyIf requires a non-empty etagMatches; refusing to downgrade a conditional write to an unconditional one",
        );
      }
      mode = { ".tag": "update", update: assertSafeEtag(normalizeEtag(expected)) };
      conditional = true;
    }

    const body = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const response = await this._request(`${CONTENT_BASE}/files/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": apiArgHeader({
          path: this._path(key),
          mode,
          // Never rename around a conflict. An autorenamed file is a second
          // copy of somebody's note with a mangled name and no conflict
          // reported — the silent overwrite, wearing a different hat.
          autorename: false,
          mute: true,
        }),
      },
      body,
    });

    if (response.status === 409) {
      // `null` means "your precondition failed" and nothing else, so a write
      // nobody made conditional must never return it. Dropbox answers
      // `path/conflict/folder` when a *folder* occupies the path of an
      // ordinary `overwrite` upload; read as a lost race, that told
      // `move_note` and `archive_note` the destination was contended when it
      // had simply not been written — and both delete the source immediately
      // afterwards. This is the only backend that could produce that, because
      // it is the only one deriving `null` from anything but a real
      // precondition.
      if (conditional && (await errorTagPath(response.clone())).split("/").includes("conflict")) {
        return null;
      }
      return this._fail(response, "upload");
    }
    if (!response.ok) return this._fail(response, "upload");

    const metadata = await response.json();
    return { etag: normalizeEtag(metadata.rev) };
  }

  async delete(key) {
    assertSafeKey(key);
    const response = await this._rpc("/files/delete_v2", { path: this._path(key) });
    // Deleting what is already gone is success, so a rollback path that runs
    // twice does not fail the second time.
    if (response.status === 409 && (await this._isNotFound(response))) return;
    if (!response.ok) await this._fail(response, "delete");
  }

  /**
   * `list` maps onto `list_folder`, and the two shapes meet more neatly than
   * they do for S3.
   *
   * A `delimiter` of "/" means "one level", which is `recursive: false`; no
   * delimiter means "everything below here", which is `recursive: true`. S3
   * has to synthesise folders out of a flat keyspace; Dropbox already has
   * them, so `delimitedPrefixes` is just the folder entries.
   */
  async list(options = {}) {
    const { prefix, delimiter, cursor, limit } = options;
    assertSafePrefix(prefix);

    const response = cursor
      ? await this._rpc("/files/list_folder/continue", { cursor })
      : await this._rpc("/files/list_folder", {
          path: this._path(prefix || "").replace(/\/$/, ""),
          recursive: delimiter !== "/",
          limit: limit || undefined,
        });

    // A folder that does not exist yet lists as empty rather than throwing:
    // this is the first thing a freshly connected, untouched context does.
    if (response.status === 409 && (await this._isNotFound(response))) {
      return { objects: [], delimitedPrefixes: [], truncated: false };
    }
    if (!response.ok) return this._fail(response, "list");

    const page = await response.json();
    const objects = [];
    const delimitedPrefixes = [];
    for (const entry of page.entries || []) {
      const key = this._key(entry.path_display || entry.path_lower);
      if (entry[".tag"] === "folder") {
        delimitedPrefixes.push(`${key}/`);
      } else if (entry[".tag"] === "file") {
        objects.push({
          key,
          size: entry.size,
          uploaded: new Date(entry.server_modified),
        });
      }
    }

    return stripListResult(this.rootPrefix, {
      objects,
      delimitedPrefixes,
      truncated: Boolean(page.has_more),
      cursor: page.has_more ? page.cursor : undefined,
    });
  }
}
