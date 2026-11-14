/**
 * Bytes for a URL attachment: https only, redirects refused, at most 25 MB,
 * read with a running cap so an oversized body is cut off, not buffered.
 *
 * The SDK's upload takes a file name and no MIME type; the server infers the
 * type from the extension. So a concrete response Content-Type is honored by
 * giving the name the matching extension.
 */
import { RequestError } from "./errors.mjs";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 20000;

const EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["image/webp", "webp"],
  ["image/tiff", "tiff"],
  ["video/mp4", "mp4"],
  ["video/quicktime", "mov"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/wav", "wav"],
  ["application/pdf", "pdf"],
]);

/** The response's type when it is concrete, else the type the caller gave. */
export function chooseMime(responseType, given) {
  const base = String(responseType ?? "").split(";")[0].trim().toLowerCase();
  const concrete = /^(image|video|audio|application)\/[a-z0-9.+-]+$/.test(base) && base !== "application/octet-stream";
  return concrete ? base : given;
}

/** The name, with its extension replaced by the one the type implies, when it is known and different. */
export function nameFor(name, mime) {
  const extension = EXTENSIONS.get(mime);
  if (!extension) return name;
  const current = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (current === extension) return name;
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return `${stem || "file"}.${extension}`;
}

/** Reads a response body, stopping with a 413 once it passes `max` bytes. */
export async function readCapped(response, max = MAX_FILE_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new RequestError(413, "too_large_url");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new RequestError(413, "too_large_url");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/** {bytes, mimeType} for an https URL; refuses anything else before the call. */
export async function fetchFile(url, given, fetchImpl = fetch) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new RequestError(400, "invalid_url");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new RequestError(400, "invalid_url");
  }
  const response = await fetchImpl(parsed.toString(), {
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new RequestError(502, "source_unavailable");
  const bytes = await readCapped(response, MAX_FILE_BYTES);
  return { bytes, mimeType: chooseMime(response.headers.get("content-type"), given) };
}
