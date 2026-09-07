/**
 * Recovering plain text from `message.attributedBody`.
 *
 * A row with `text IS NULL` still has a body wherever the message carries any
 * rich content — an edited message, a message with an inline reply, one sent
 * from an app that only ever produces attributed strings. macOS puts that in
 * `attributedBody`, an archived `NSAttributedString`. Depending on the macOS
 * version that wrote it, the bytes are one of two archiver formats — the
 * legacy `streamtyped` `NSArchiver` format (pre–Big Sur), or an
 * `NSKeyedArchiver` binary property list (`bplist00`, Big Sur and later) — and
 * this app has no way to know in advance which Mac it is reading from.
 *
 * Both formats encode the underlying `NSString`/`NSMutableString` the same way
 * in the one place that matters here: the literal ASCII bytes of the class
 * name, `NSString`, immediately followed — within a handful of
 * archiver-metadata bytes — by a length-prefixed run of the string's own UTF-8
 * bytes. A full parse of either format would mean either walking a
 * typedstream class-version table or resolving `NSKeyedArchiver`'s `$objects`
 * / `UID` reference graph out of a binary plist — real parsers, and
 * considerably more code than the one fact this app needs out of the blob.
 * `extractAttributedBodyText` is a **byte-pattern heuristic** instead: find
 * the class name, scan a short, bounded window past it for a byte that reads
 * as a plausible length, and accept the following bytes as the string if they
 * decode as mostly-printable UTF-8 of that length.
 *
 * ## What this buys, and what it costs
 *
 * No bplist parser, no `NSKeyedArchiver` graph walk, and a decoder a test can
 * pin with a hand-built fixture in a few dozen lines. What it costs: this is
 * not a general `NSAttributedString` reader. A blob with no recoverable string
 * (a lone attachment placeholder, a format neither scan matches, genuinely
 * corrupt data) answers `null` rather than throwing — the caller's fallback is
 * an empty body, never a sync failure, because losing the text of one
 * hard-to-parse message is a far smaller defect than losing a whole day's
 * import to it.
 *
 * `NSString` is searched for from the **end** of the blob backward, and the
 * *first* match found that way (i.e. the last one in byte order) is used. The
 * class name also appears earlier in both formats — naming the archiver's own
 * class table — and the payload the archiver actually wrote trails it.
 */

const NSSTRING = new TextEncoder().encode("NSString");

/** How far past the "NSString" marker to look for a length byte. Generous, not exact — see the header. */
const SCAN_WINDOW = 24;

/** A decoded candidate is rejected if it is empty or longer than this. */
const MAX_CANDIDATE_LENGTH = 20_000;

const DECODER = new TextDecoder("utf-8", { fatal: true });

/** Find the last occurrence of `needle` in `haystack`, or -1. */
function lastIndexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (let start = haystack.length - needle.length; start >= 0; start -= 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

/**
 * Decode `bytes` as UTF-8 and reject anything that does not read as ordinary
 * message text: invalid UTF-8, or any C0/C1 control character other than a
 * plain space. Real message bodies are language, not binary — a candidate
 * carrying control bytes is archiver structure the scan mistook for a string.
 */
function decodeIfPlausibleText(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > MAX_CANDIDATE_LENGTH) return null;
  let text: string;
  try {
    text = DECODER.decode(bytes);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- exactly the bytes being screened for,
  // and written as \u escapes rather than literal bytes so this source file stays plain ASCII.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return null;
  return text;
}

/**
 * One candidate length-prefix reading, tried at a single offset.
 *
 * Two shapes are tried at every offset, because the two archiver formats
 * spell "how long is the string" differently and this scan does not know
 * which one it is looking at:
 *
 *  - a **single byte** `1..0x80`, read directly as the length (the
 *    `streamtyped` short-string form, and also `NSKeyedArchiver`'s bplist
 *    ASCII-string marker low nibble for short strings, close enough in shape
 *    to share this branch); and
 *  - the byte **`0x81`** followed by a little-endian `uint16` length (the
 *    `streamtyped` long-string form).
 *
 * Returns the decoded string, or `null` if neither shape produces a
 * plausible one at this offset — including when a shape names a length that
 * simply does not fit inside the blob. `extractAttributedBodyText` keeps
 * scanning past every `null` here, which is deliberate and imperfect in a
 * documented direction: real archiver padding is a handful of bytes with no
 * guaranteed length, so the scan cannot stop at the first offset that merely
 * *looks* like a length — measured against a real archived blob, where the
 * true length byte sits three bytes after a padding byte that itself reads as
 * a tiny, valid-but-wrong one-byte length. The cost of scanning past a
 * rejection is the mirror problem: a coincidental short match *inside* the
 * real string's own bytes can occasionally be accepted before the scan
 * reaches the true length byte. Between the two, favouring "keep looking" is
 * the one that recovers real message text on real data, which is this
 * module's actual job — see the header for what a wrong or missing answer
 * costs when it happens.
 */
function tryReadAt(bytes: Uint8Array, offset: number): string | null {
  const marker = bytes[offset];
  if (marker === undefined) return null;

  if (marker === 0x81 && offset + 3 <= bytes.length) {
    const length = (bytes[offset + 2] ?? 0) * 256 + (bytes[offset + 1] ?? 0);
    const start = offset + 3;
    if (start + length <= bytes.length) {
      const candidate = decodeIfPlausibleText(bytes.subarray(start, start + length));
      if (candidate !== null) return candidate;
    }
  }

  if (marker >= 1 && marker <= 0x80) {
    const start = offset + 1;
    if (start + marker <= bytes.length) {
      const candidate = decodeIfPlausibleText(bytes.subarray(start, start + marker));
      if (candidate !== null) return candidate;
    }
  }

  return null;
}

/**
 * Recover the plain text from an archived `NSAttributedString`/`NSString`
 * blob, or `null` if none could be found.
 *
 * @param bytes The raw bytes of `message.attributedBody` — decode `hex(...)`
 *   before calling this; see `attributedBodyFromHex`.
 */
export function extractAttributedBodyText(bytes: Uint8Array): string | null {
  const markerAt = lastIndexOfBytes(bytes, NSSTRING);
  if (markerAt === -1) return null;

  const windowEnd = Math.min(bytes.length, markerAt + NSSTRING.length + SCAN_WINDOW);
  for (let offset = markerAt + NSSTRING.length; offset < windowEnd; offset += 1) {
    const found = tryReadAt(bytes, offset);
    if (found !== null) return found.trim() || null;
  }
  return null;
}

/** `hex(attributedBody)` from the query, decoded to bytes and run through `extractAttributedBodyText`. */
export function attributedBodyFromHex(hex: unknown): string | null {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return extractAttributedBodyText(bytes);
}
