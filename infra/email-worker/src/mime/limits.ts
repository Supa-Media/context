/**
 * Bounds, attachment policy and the image-store prefix for the MIME parser.
 *
 * Split out of `../mime.ts`; see that file's docblock for the parser's threat
 * model. This module carries no parsing logic, only the caps everything else
 * in `mime/` is checked against.
 */

/** Every bound the parser will honour. All of them bite; none of them throw. */
export interface MimeLimits {
  /** Whole-message cap. Checked by the caller before the stream is drained. */
  maxRawBytes: number;
  /** Cap on one entity's header block, before unfolding. */
  maxHeaderBytes: number;
  /** Cap on the number of headers kept for one entity. */
  maxHeaderCount: number;
  /** Cap on total MIME entities walked across the whole tree. */
  maxParts: number;
  /** Cap on `multipart` nesting depth. */
  maxDepth: number;
  /** Cap on the extracted body text, in characters. */
  maxTextChars: number;
  /** Cap on HTML handed to the converter, in characters. */
  maxHtmlChars: number;
  /** Cap on the number of attachments described. */
  maxAttachments: number;
  /** Cap on the bytes kept for one attachment. */
  maxAttachmentBytes: number;
  /** Cap on one header value after unfolding, in characters. */
  maxHeaderValueChars: number;
}

/**
 * Conservative by default. A capture is a note, not a file transfer: the point
 * of the caps is that the common case fits easily and the abusive case is
 * refused cheaply.
 */
/**
 * The largest per-attachment buffer this worker will ever allocate, whatever
 * the control plane asks for.
 *
 * Distinct from `DEFAULT_MIME_LIMITS.maxAttachmentBytes`, and the difference is
 * load-bearing: that one is the **fallback** used when nobody has configured
 * anything, and an owner is allowed to raise their cap above it. This one is a
 * ceiling nobody can raise. Clamping an owner's value to the fallback instead
 * would make the setting able only to lower, so a console offering 5 MB would
 * quietly deliver 2.
 *
 * It matches `MAX_ATTACHMENT_BYTES_CEILING` in the control plane, which is in
 * turn bounded by what the MCP gateway will serve back — storing an attachment
 * larger than `read_image` returns writes bytes into the customer's bucket that
 * nothing in Context can ever read.
 */
export const MAX_ATTACHMENT_BYTES_HARD_CAP = 5_000_000;

/**
 * The attachment types `attachmentPolicy: "store"` will actually write, and the
 * extension each one lands under.
 *
 * Storing is not "keep everything". The MCP gateway hands an image back only
 * through `read_image`, which serves an allowlist of image types; every other
 * read path there is gated on `.md`. So an attachment outside this map has no
 * way back out of the bucket, and writing one would put a stranger's bytes in
 * the customer's storage to produce a link nothing in Context can follow. Those
 * attachments stay described-only, exactly as they are under `list`.
 *
 * `image/jpeg` canonicalizes to `jpg`; the gateway accepts both spellings on the
 * way back. SVG is deliberately absent on both sides — it is a script container
 * and the client renders what the gateway returns.
 *
 * A check in ../ingest.test.ts reads the gateway's own map and fails if an
 * extension here stops being servable. The two cannot share a module: the
 * gateway is dependency-free on purpose.
 */
export const STORABLE_IMAGE_TYPES: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
]);

/** The opaque, unlistable store images are written into. */
import { IMAGE_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";

export const IMAGE_STORE_PREFIX = IMAGE_PREFIX;

/** The extension for a content type we will store, or null for one we will not. */
export function storableImageExtension(contentType: string): string | null {
  // `image/png; charset=binary` and casing both occur in the wild.
  const bare = contentType.split(";")[0]!.trim().toLowerCase();
  return STORABLE_IMAGE_TYPES.get(bare) ?? null;
}

export const DEFAULT_MIME_LIMITS: MimeLimits = {
  maxRawBytes: 5_000_000,
  maxHeaderBytes: 128_000,
  maxHeaderCount: 200,
  maxParts: 200,
  maxDepth: 12,
  maxTextChars: 200_000,
  maxHtmlChars: 500_000,
  maxAttachments: 20,
  maxAttachmentBytes: 2_000_000,
  maxHeaderValueChars: 8_000,
};
