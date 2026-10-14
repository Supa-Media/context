/**
 * Server-side copy of an object too big for one CopyObject.
 *
 * S3 and R2 copy at most 5 GiB in one request. Past that the copy is a
 * multipart upload whose parts are copied from the source by range
 * (`UploadPartCopy`), so the bytes still never leave the provider: a 40 GB
 * video moves in the same few seconds per part whatever runs this.
 *
 * The same guarantees as a one-request copy, kept the same way:
 *  - **Only from the version the caller saw.** Every part carries
 *    `x-amz-copy-source-if-match`; a source changed mid-copy fails its part
 *    with 412, and the copy answers `null` exactly as a one-request copy does.
 *  - **Only onto nothing.** With `onlyIf.absent` the destination is checked
 *    before starting and the completion carries `If-None-Match: *`, so a
 *    destination written meanwhile is a `null`, never an overwrite.
 *  - **Nothing left behind.** Any failure aborts the upload, so no invisible
 *    half-copy keeps costing the customer storage.
 *  - **Recognisable on a re-run.** A multipart object's etag is not its
 *    source's, so the copy is stamped `x-amz-meta-context-copy-of: <etag>`;
 *    a worker that died after the copy and before retiring the source can tell
 *    its own copy from a stranger's (`moveObject`).
 *
 * Each part is retried a few times on a transient failure; a part that keeps
 * failing fails the copy, which its caller retries as a whole.
 */

import { assertSafeEtag, normalizeEtag } from "./index.js";
import { decodeXmlText, readCappedText, readTag, s3Error } from "./s3.js";

/** One CopyObject's limit on S3 and R2. */
export const SINGLE_COPY_MAX_BYTES = 5 * 1024 ** 3;
/** Part size: 512 MiB copies a 5 TiB object (the provider maximum) within 10,000 parts. */
export const COPY_PART_BYTES = 512 * 1024 ** 2;
/** The provider's part-count limit. */
const MAX_PARTS = 10_000;
/** Parts copied at once. */
const PART_POOL = 4;
/** Tries of one part. */
const PART_TRIES = 3;
/** The metadata header naming the version a multipart copy was taken from. */
export const COPY_OF_HEADER = "x-amz-meta-context-copy-of";
const RESPONSE_CAP = 64_000;

/** The source changed while its parts were copied: the copy answers `null`. */
class SourceChanged extends Error {}

/** `[start, end]` byte ranges (inclusive) for a copy of `size` bytes, at least `partBytes` each. */
export function copyPartRanges(size, partBytes = COPY_PART_BYTES) {
  const total = Math.max(0, Math.floor(size));
  const part = Math.max(Math.floor(partBytes), Math.ceil(total / MAX_PARTS), 1);
  const ranges = [];
  for (let start = 0; start < total; start += part) ranges.push([start, Math.min(start + part, total) - 1]);
  return ranges;
}

function uploadsUrl(store, key) {
  const url = store.urlFor(key);
  // `?uploads` takes no value; `urlFor` drops empty parameters, so it is set here.
  url.search = "uploads=";
  return url;
}

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

async function copyPart(store, key, uploadId, partNumber, range, source, sourceEtag) {
  let lastError;
  for (let attempt = 0; attempt < PART_TRIES; attempt += 1) {
    try {
      const response = await store.send("PUT", store.urlFor(key, { partNumber, uploadId }), {
        headers: {
          "x-amz-copy-source": store.copySource(source),
          "x-amz-copy-source-range": `bytes=${range[0]}-${range[1]}`,
          "x-amz-copy-source-if-match": `"${sourceEtag}"`,
        },
      });
      if (response.status === 412) throw new SourceChanged();
      if (!response.ok) throw await s3Error("COPY PART", key, response);
      const xml = await readCappedText(response, RESPONSE_CAP, "COPY PART");
      const etag = decodeXmlText(readTag(xml, "ETag"));
      if (!etag) throw new Error(`S3 COPY PART ${key} answered no ETag`);
      return { partNumber, etag: normalizeEtag(etag) };
    } catch (error) {
      if (error instanceof SourceChanged) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function eachPart(ranges, work) {
  const results = new Array(ranges.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(PART_POOL, ranges.length) }, async () => {
    while (next < ranges.length) {
      const index = next++;
      results[index] = await work(index + 1, ranges[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Copy `source` to `destination` within one bucket in parts.
 *
 * @param {import("./s3.js").S3Store} store
 * @param {{ size: number, contentType?: string, onlyIf?: { absent?: boolean }, sourceOnlyIf?: { etagMatches?: string } }} options
 * @returns {Promise<{ etag: string } | null>} `null` when a precondition failed
 */
export async function multipartCopy(store, source, destination, options) {
  const sourceEtag = options?.sourceOnlyIf?.etagMatches;
  // A part copy can only be pinned to a version the caller names; an unpinned
  // multipart copy could stitch parts of two different versions together.
  if (!sourceEtag) throw new Error("a multipart copy needs the source etag it copies from");
  const pinned = assertSafeEtag(normalizeEtag(sourceEtag));
  const absent = options?.onlyIf?.absent === true;
  if (absent && (await store.head(destination)) !== null) return null;

  const created = await store.send("POST", uploadsUrl(store, destination), {
    headers: {
      ...(options?.contentType ? { "content-type": options.contentType } : {}),
      [COPY_OF_HEADER]: pinned,
    },
  });
  if (!created.ok) throw await s3Error("CREATE MULTIPART", destination, created);
  const uploadId = decodeXmlText(readTag(await readCappedText(created, RESPONSE_CAP, "CREATE MULTIPART"), "UploadId"));
  if (!uploadId) throw new Error(`S3 CREATE MULTIPART ${destination} answered no UploadId`);

  const abort = () =>
    store.send("DELETE", store.urlFor(destination, { uploadId })).catch(() => undefined);
  try {
    const parts = await eachPart(copyPartRanges(options.size, store.copyPartBytes), (partNumber, range) =>
      copyPart(store, destination, uploadId, partNumber, range, source, pinned));
    const body =
      `<CompleteMultipartUpload>` +
      parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${xmlEscape(part.etag)}"</ETag></Part>`).join("") +
      `</CompleteMultipartUpload>`;
    const completed = await store.send("POST", store.urlFor(destination, { uploadId }), {
      headers: { "content-type": "application/xml", ...(absent ? { "if-none-match": "*" } : {}) },
      body: new TextEncoder().encode(body),
    });
    if (absent && completed.status === 412) {
      await abort();
      return null;
    }
    if (!completed.ok) throw await s3Error("COMPLETE MULTIPART", destination, completed);
    // A completion can fail after its 200 has been sent: the error is in the body.
    const xml = await readCappedText(completed, RESPONSE_CAP, "COMPLETE MULTIPART");
    if (readTag(xml, "Error") !== null || /<Error>/.test(xml)) {
      throw new Error(`S3 COMPLETE MULTIPART ${destination} failed: ${readTag(xml, "Code") ?? "unknown"}`);
    }
    return { etag: normalizeEtag(decodeXmlText(readTag(xml, "ETag")) || "") };
  } catch (error) {
    await abort();
    if (error instanceof SourceChanged) return null;
    throw error;
  }
}
