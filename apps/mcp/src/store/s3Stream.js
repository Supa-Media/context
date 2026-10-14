/**
 * Copy one object between two buckets in parts, so its size never has to fit
 * in memory (project file `move-engine/plan.md`, step D).
 *
 * A whole-bucket move reads each object whole, and a Convex action has 64 MB:
 * a recording or a video failed the move for good. Here the source is read a
 * range at a time and each range is uploaded as one part of a multipart
 * upload on the destination, a few parts in flight, so memory stays at a few
 * parts whatever the object's size.
 *
 * The same guarantees a whole-object copy has:
 *  - **One version, never two stitched together.** Every range is read with
 *    `If-Match: <the etag listed>`; a source changed mid-copy answers 412 and
 *    the copy answers `{ state: "changed" }` with nothing landed.
 *  - **Nothing left behind.** Any failure aborts the upload. An upload a dead
 *    worker left open is aborted by the next attempt at the same key
 *    (`abortOpenUploads`), so a customer's bucket does not keep paying for
 *    invisible half-copies.
 *  - **Recognisable on a re-run.** The copy is stamped
 *    `x-amz-meta-context-copy-of: <source etag>` (a multipart object's etag is
 *    not its source's), so a later pass can tell its own finished copy.
 *
 * Only plain S3-compatible adapters on both sides (`canStream`); a sealed
 * managed object is one encrypted piece and is never streamed (chunked
 * sealing is a decision still open).
 */

import { applyRootPrefix } from "./index.js";
import { isManagedEnvelope } from "./managedEncryption.js";
import { COPY_OF_HEADER } from "./s3Multipart.js";
import { decodeXmlText, readCappedText, readTag, s3Error } from "./s3.js";

/** Part size: well above the 5 MiB minimum, small enough that a few in flight fit an action. */
export const STREAM_PART_BYTES = 8 * 1024 * 1024;
/** Parts in flight at once. */
const STREAM_POOL = 2;
const PART_TRIES = 3;
const MAX_PARTS = 10_000;
const RESPONSE_CAP = 256_000;

class SourceChanged extends Error {}
class SealedSource extends Error {}

/** Whether `store` is an S3 adapter (possibly wrapped) this module can drive. */
export function canStream(store) {
  return Boolean(store) && typeof store.send === "function" && typeof store.urlFor === "function" &&
    typeof store.bucketUrl === "function";
}

/** Read bytes `[start, end]` of `key`, only from the version `etag` names. */
export async function readRange(store, key, start, end, etag) {
  const response = await store.send("GET", store.urlFor(key), {
    headers: { range: `bytes=${start}-${end}`, "if-match": `"${etag}"` },
  });
  if (response.status === 412 || response.status === 404) throw new SourceChanged();
  if (response.status !== 206 && response.status !== 200) throw await s3Error("GET RANGE", key, response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A 200 is the whole object: a provider that ignored the range. Never take it as a part.
  if (response.status === 200 && !(start === 0 && bytes.byteLength === end + 1)) {
    throw new Error(`S3 GET RANGE ${key} answered the whole object`);
  }
  if (bytes.byteLength !== end - start + 1) throw new Error(`S3 GET RANGE ${key} answered ${bytes.byteLength} bytes`);
  return bytes;
}

/** `[start, end]` ranges of at least `partBytes`, within the provider's part limit. */
export function streamPartRanges(size, partBytes = STREAM_PART_BYTES) {
  const part = Math.max(Math.floor(partBytes), Math.ceil(size / MAX_PARTS), 1);
  const ranges = [];
  for (let start = 0; start < size; start += part) ranges.push([start, Math.min(start + part, size) - 1]);
  return ranges;
}

function uploadsUrl(store, key, extra = "") {
  const url = store.urlFor(key);
  url.search = `uploads=${extra}`;
  return url;
}

/**
 * Abort every multipart upload still open at exactly `key` on `store`: what a
 * worker that died mid-copy left. Best effort; a listing it cannot read is
 * left for the provider's own expiry.
 */
export async function abortOpenUploads(store, key) {
  try {
    const stored = applyRootPrefix(store.rootPrefix, key);
    const listUrl = store.bucketUrl({ prefix: stored });
    listUrl.search = `${listUrl.search.replace(/^\?/, "")}&uploads=`;
    const response = await store.send("GET", listUrl);
    if (!response.ok) return 0;
    const xml = await readCappedText(response, RESPONSE_CAP, "LIST UPLOADS");
    let aborted = 0;
    for (const match of xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
      const uploadKey = decodeXmlText(readTag(match[1], "Key"));
      const uploadId = decodeXmlText(readTag(match[1], "UploadId"));
      if (uploadKey !== stored || !uploadId) continue;
      await store.send("DELETE", store.urlFor(key, { uploadId })).catch(() => undefined);
      aborted += 1;
    }
    return aborted;
  } catch {
    return 0;
  }
}

async function uploadPart(target, key, uploadId, partNumber, bytes) {
  let lastError;
  for (let attempt = 0; attempt < PART_TRIES; attempt += 1) {
    try {
      const response = await target.send("PUT", target.urlFor(key, { partNumber, uploadId }), { body: bytes });
      if (!response.ok) throw await s3Error("UPLOAD PART", key, response);
      const etag = response.headers.get("etag");
      if (!etag) throw new Error(`S3 UPLOAD PART ${key} answered no ETag`);
      return { partNumber, etag: etag.replace(/^"(.*)"$/, "$1") };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function readPart(source, key, range, etag, partNumber) {
  let lastError;
  for (let attempt = 0; attempt < PART_TRIES; attempt += 1) {
    try {
      const bytes = await readRange(source, key, range[0], range[1], etag);
      if (partNumber === 1 && isManagedEnvelope(bytes)) throw new SealedSource();
      return bytes;
    } catch (error) {
      if (error instanceof SourceChanged || error instanceof SealedSource) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Copy `key` from `source` to the same key on `target`, in parts.
 *
 * @param {{ size: number, etag: string, contentType: string, partBytes?: number }} options
 * @returns {Promise<{ state: "done", etag: string } | { state: "changed" } | { state: "sealed" }>}
 */
export async function streamObject(source, target, key, options) {
  const { size, etag } = options;
  if (!(size > 0) || typeof etag !== "string" || etag === "") throw new Error("a streamed copy needs the source's size and etag");
  await abortOpenUploads(target, key);
  const created = await target.send("POST", uploadsUrl(target, key), {
    headers: { "content-type": options.contentType, [COPY_OF_HEADER]: etag },
  });
  if (!created.ok) throw await s3Error("CREATE MULTIPART", key, created);
  const uploadId = decodeXmlText(readTag(await readCappedText(created, RESPONSE_CAP, "CREATE MULTIPART"), "UploadId"));
  if (!uploadId) throw new Error(`S3 CREATE MULTIPART ${key} answered no UploadId`);
  const abort = () => target.send("DELETE", target.urlFor(key, { uploadId })).catch(() => undefined);

  try {
    const ranges = streamPartRanges(size, options.partBytes);
    const parts = new Array(ranges.length);
    let next = 0;
    let failed = null;
    const runners = Array.from({ length: Math.min(STREAM_POOL, ranges.length) }, async () => {
      while (next < ranges.length && failed === null) {
        const index = next++;
        try {
          const bytes = await readPart(source, key, ranges[index], etag, index + 1);
          parts[index] = await uploadPart(target, key, uploadId, index + 1, bytes);
        } catch (error) {
          failed ??= error;
        }
      }
    });
    await Promise.all(runners);
    if (failed !== null) throw failed;
    const body =
      `<CompleteMultipartUpload>` +
      parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.etag}"</ETag></Part>`).join("") +
      `</CompleteMultipartUpload>`;
    const completed = await target.send("POST", target.urlFor(key, { uploadId }), {
      headers: { "content-type": "application/xml" },
      body: new TextEncoder().encode(body),
    });
    if (!completed.ok) throw await s3Error("COMPLETE MULTIPART", key, completed);
    // A completion can fail after its 200 has been sent: the error is in the body.
    const xml = await readCappedText(completed, RESPONSE_CAP, "COMPLETE MULTIPART");
    if (/<Error>/.test(xml)) throw new Error(`S3 COMPLETE MULTIPART ${key} failed: ${readTag(xml, "Code") ?? "unknown"}`);
    return { state: "done", etag: (decodeXmlText(readTag(xml, "ETag")) || "").replace(/^"(.*)"$/, "$1") };
  } catch (error) {
    await abort();
    if (error instanceof SourceChanged) return { state: "changed" };
    if (error instanceof SealedSource) return { state: "sealed" };
    throw error;
  }
}
