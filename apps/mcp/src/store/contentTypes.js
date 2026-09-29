/**
 * The content types a stored object may be written as, split out of
 * `store/index.js`, which re-exports them.
 */

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
 *
 * `application/octet-stream` is the one entry that is not "the gateway can
 * serve this back inline" — it is "a browser will never execute this
 * inline", which is the property a fetched email attachment needs. An
 * attachment's real MIME type is sender-chosen text, exactly as untrusted as
 * its filename, and writing it verbatim as the stored `content-type` would
 * mean a customer's own tooling that later serves their bucket over HTTP
 * (a browser extension, a static file server pointed at it, anything that
 * trusts the object's declared type) could be handed `text/html` or
 * `image/svg+xml` from a stranger and render it as a page rather than
 * download it — the exact class of attack SVG's absence above already
 * guards against, reached from the other direction. So every attachment this
 * product stores is written as `application/octet-stream` regardless of what
 * Gmail reports the part's `mimeType` as; the real type is preserved as text
 * in the channel-day note (`**Attachments**: name — type, size`), which is
 * metadata, never a header a client's transport trusts.
 */
export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";
export const ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
export const LOGICAL_DELETE_CONTENT_TYPE = "application/x-context-logical-tombstone";

export const WRITABLE_CONTENT_TYPES = new Set([
  MARKDOWN_CONTENT_TYPE,
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  // A cast scene's uploaded sounds, kept beside images in the asset store and
  // read back only through a note that names them. Their bytes are checked to
  // be the format named before they reach here (`sceneSounds.ts`).
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  ATTACHMENT_CONTENT_TYPE,
  LOGICAL_DELETE_CONTENT_TYPE,
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
