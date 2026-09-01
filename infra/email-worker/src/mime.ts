/**
 * A hand-written MIME reader for hostile input.
 *
 * Pure: no Workers-runtime APIs, no configuration, no I/O. Give it the bytes of
 * an RFC 5322 message and it gives you a normalised view of them. That makes
 * every parsing property in this file testable with a byte array and no runtime.
 *
 * ── Why by hand ─────────────────────────────────────────────────────────────
 *
 * The gateway is dependency-free and this Worker is held to the same rule: a
 * self-hoster clones the repo and deploys it, and an npm dependency in the path
 * of every inbound message is a supply-chain hole in someone else's private
 * notes. MIME parsing by hand is real work, but it is bounded work, and the
 * parts that matter for safety (bounded recursion, bounded output, no
 * backtracking) are exactly the parts a general-purpose library gets wrong for
 * an adversarial feed.
 *
 * ── The threat model ────────────────────────────────────────────────────────
 *
 * Every byte here was written by a stranger who chose it. So:
 *
 * - **`parseEmail` never throws.** A structure designed to blow up a parser
 *   produces a `ParsedEmail` with `problems` set, not an exception the caller
 *   forgot to catch. Failing closed is the caller's job and it can only do that
 *   job if it is handed a value.
 * - **Everything is bounded.** Depth, part count, header count, header bytes,
 *   text length, attachment count and attachment size all have caps, and each
 *   cap that bites is recorded in `problems`. A 3 MB message of nested
 *   `multipart/mixed` is a resource attack, not a mail.
 * - **Every scan is linear.** The regexes in this file use negated character
 *   classes with no nested quantifiers, so none of them can backtrack
 *   catastrophically. Anything that could not be written that way — HTML in
 *   particular, see ./html.ts — is a hand-written character scanner instead.
 * - **No entity resolution, no external references.** MIME has no XXE, but it
 *   does have `message/external-body`, which asks the reader to go fetch
 *   something. This parser fetches nothing, ever; such a part is an opaque leaf.
 *
 * ── Deliberate omissions ────────────────────────────────────────────────────
 *
 * - **`Authentication-Results` is collected but never interpreted here.** The
 *   values, their order, and whether each arrived folded are handed to
 *   ./auth.ts, which is the one place allowed to decide what they mean —
 *   because every one of them is forgeable by the sender and telling ours apart
 *   from theirs rests entirely on position. The same goes for
 *   `ARC-Authentication-Results`, which additionally records *where* it sat
 *   relative to the topmost `Authentication-Results`; see `ArcHeader`.
 *   Nothing from either header is rendered into a capture: a note that
 *   displayed `dkim=pass` because the attacker typed it would be worse than one
 *   that shows nothing, so ./note.ts records only the verdict ./auth.ts
 *   reached, and marks every capture unverified besides.
 * - **The `From:` display name is parsed but never rendered as the sender.**
 *   `From: Seyi <attacker@example.net>` is free to claim anything. Only the
 *   addr-spec is authoritative, and the caller compares it to the envelope.
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
 * A check in ./ingest.test.ts reads the gateway's own map and fails if an
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
export const IMAGE_STORE_PREFIX = ".images/";

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

export interface ParsedAttachment {
  /** Sanitised, may be `""` when the part named itself nothing usable. */
  filename: string;
  /** Lowercased `type/subtype`, or `application/octet-stream`. */
  contentType: string;
  /** Decoded bytes, or `null` when the part exceeded `maxAttachmentBytes`. */
  bytes: Uint8Array | null;
  /** Decoded size in bytes, even when `bytes` is `null`. */
  size: number;
}

export interface ParsedEmail {
  subject: string;
  /** addr-spec from the `From:` header. Never the display name. */
  fromAddress: string;
  /** addr-spec from the first `To:` address, for reference only. */
  toAddress: string;
  /** The `Date:` header, unparsed and single-lined. */
  date: string;
  /** The `Message-ID:` header, angle brackets stripped. */
  messageId: string;
  /** Normalised body text. Markdown-ish; never HTML. */
  text: string;
  textSource: "plain" | "html" | "none";
  attachments: ParsedAttachment[];
  /**
   * Every `Authentication-Results` header value, **in the order they appear**.
   *
   * Order is load-bearing and is why this is a list rather than a lookup: the
   * receiving MTA prepends its verdict, so the first entry is the only one with
   * any claim to authority and everything below it may have been typed by the
   * sender. A `Headers` object joins duplicates and destroys exactly the
   * information ./auth.ts depends on. See `verifySender`.
   */
  authenticationResults: string[];
  /**
   * Parallel to `authenticationResults`: whether each value was assembled from
   * folded continuation lines. See `headerValuesFolded` — a folded verdict is
   * one the sender may have written into.
   */
  authenticationResultsFolded: boolean[];
  /**
   * Parallel again: the value as it stood on the header's **first physical
   * line**, before any continuation was appended.
   *
   * This is the only part of a folded header that our MTA provably wrote.
   * Unfolding concatenates continuation lines *after* the first line, so
   * whatever a sender spliced on lands strictly to the right of it — and the
   * first line is exactly the bytes the MTA emitted before its own first CRLF.
   * `./auth.ts` reads this instead of the whole value when the header arrived
   * folded; see rule 1a in `verifySender`.
   *
   * Equal to the full value for a header that was not folded.
   */
  authenticationResultsFirstLine: string[];
  /**
   * Every `ARC-Authentication-Results` header (RFC 8617 §4.1.1), in order.
   *
   * This is how the *original* authentication verdict survives a forwarding
   * hop: `From:` stays the same while the delivering hop's DKIM signature
   * belongs to the forwarder, so ordinary alignment fails and only the chain
   * still carries what the first receiver saw. `./auth.ts` decides, very
   * carefully, when any of it may be believed.
   */
  arcAuthenticationResults: ArcHeader[];
  /**
   * Machine-readable tags for structured logs: which caps bit, what was
   * malformed. **Never carries message content** — these strings are safe to
   * log, and nothing else in this type is.
   */
  problems: string[];
}

/**
 * One `ARC-Authentication-Results` header, with the two facts about it that
 * cannot be recovered from its text.
 */
export interface ArcHeader {
  /** The header value, unfolded. Begins with the ARC instance tag, `i=N;`. */
  value: string;
  /** Assembled from folded continuation lines — i.e. sender-extendable. */
  folded: boolean;
  /**
   * It appears strictly **above** the topmost `Authentication-Results`.
   *
   * That is the only evidence in a message that separates a header our MTA
   * wrote from one the sender did. The receiving MTA prepends its trace block
   * as a unit at the very top, so everything the sender wrote — including any
   * `ARC-Authentication-Results` they invented, with any authserv-id and any
   * instance number they liked — necessarily sits *below* it. This Worker
   * already stakes everything on "the topmost `Authentication-Results` is
   * ours"; anything above that header is inside the same block and is ours by
   * the same argument, and nothing below it is trustworthy on position alone.
   *
   * `false` when there is no `Authentication-Results` at all: with no anchor
   * there is no block boundary to be inside, and the conservative reading is
   * the only safe one.
   */
  abovePrimary: boolean;
}

/* ------------------------------ byte helpers ------------------------------ */

const UTF8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/**
 * Bytes → a string where one char is one byte.
 *
 * The whole parser works on this representation: MIME's structural syntax is
 * ASCII, so byte-per-char lets `indexOf` do the scanning at native speed while
 * keeping the payload lossless until a part's declared charset is known.
 * Chunked because `String.fromCharCode.apply` on a multi-megabyte array blows
 * the argument limit.
 */
function latin1Decode(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  if (bytes.length <= CHUNK) {
    return String.fromCharCode(...(bytes as unknown as number[]));
  }
  let out = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    const slice = bytes.subarray(index, index + CHUNK);
    out += String.fromCharCode(...(slice as unknown as number[]));
  }
  return out;
}

/** The inverse: a byte-per-char string back to the bytes it stood for. */
function latin1Encode(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    out[index] = value.charCodeAt(index) & 0xff;
  }
  return out;
}

/**
 * The 0x80–0x9F block, which is where windows-1252 and ISO-8859-1 disagree and
 * where every real-world mislabelled message lives. Below 0x80 and above 0x9F
 * the two agree with Unicode code points, so only this range needs a table.
 */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018,
  0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161,
  0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

function cp1252Decode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    out +=
      byte >= 0x80 && byte <= 0x9f
        ? String.fromCharCode(CP1252_HIGH[byte - 0x80]!)
        : String.fromCharCode(byte);
  }
  return out;
}

/**
 * Decode a part's bytes using its declared charset.
 *
 * UTF-8 and the Latin-1 family are decoded here rather than through
 * `TextDecoder`, because the Workers runtime's `TextDecoder` is documented as
 * UTF-8-only and constructing it with any other label throws. Anything outside
 * those families is attempted through the platform and falls back to UTF-8,
 * which is right far more often in 2026 than any single legacy guess.
 */
export function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = charset.toLowerCase().trim().replace(/^"|"$/g, "");
  if (!label || label === "utf-8" || label === "utf8" || label === "us-ascii" || label === "ascii") {
    return UTF8.decode(bytes);
  }
  if (
    label === "iso-8859-1" ||
    label === "iso8859-1" ||
    label === "latin1" ||
    label === "latin-1" ||
    label === "windows-1252" ||
    label === "cp1252"
  ) {
    return cp1252Decode(bytes);
  }
  try {
    return new TextDecoder(label, { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch {
    return UTF8.decode(bytes);
  }
}

/* ------------------------------- headers ---------------------------------- */

/** Collapse anything that could break out of a single line or a YAML scalar. */
export function singleLine(value: string): string {
  return value
    // Every C0/C1 control character, plus the Unicode line/paragraph
    // separators, plus the bidi overrides that can make a rendered line read as
    // its own reverse. Replaced with a space rather than removed, so
    // "a<LS>b" cannot become the single token "ab".
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

interface Header {
  name: string;
  value: string;
  /**
   * Whether this value was assembled from one or more folded continuation
   * lines. Load-bearing for the authentication headers: see
   * `headerValuesFolded`.
   */
  folded: boolean;
  /**
   * The value as it stood on the first physical line, before any continuation
   * was appended. Identical to `value` when `folded` is false.
   *
   * See `ParsedEmail.authenticationResultsFirstLine` for why this is worth
   * keeping: it is the part of a folded header a sender cannot have written.
   */
  firstLine: string;
}

/**
 * Split an entity at the first empty line: RFC 5322 says the header block ends
 * there and everything after is the body, whatever it looks like.
 *
 * A message with no empty line at all is all headers and an empty body. That is
 * the right reading — and notably not "treat the whole thing as a body", which
 * would let a sender hide a payload from every header-based check.
 */
function splitEntity(source: string): { head: string; body: string } {
  const crlf = source.indexOf("\r\n\r\n");
  const lf = source.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    return { head: source.slice(0, crlf), body: source.slice(crlf + 4) };
  }
  if (lf >= 0) {
    return { head: source.slice(0, lf), body: source.slice(lf + 2) };
  }
  return { head: source, body: "" };
}

function parseHeaders(head: string, limits: MimeLimits, problems: Set<string>): Header[] {
  let block = head;
  if (block.length > limits.maxHeaderBytes) {
    block = block.slice(0, limits.maxHeaderBytes);
    problems.add("header_block_truncated");
  }

  const headers: Header[] = [];
  let current: string | null = null;
  let folded = false;
  /** `current` snapshotted at the moment the *first* continuation extended it. */
  let firstPhysicalLine: string | null = null;

  const flush = () => {
    if (current === null) return;
    const colon = current.indexOf(":");
    if (colon > 0) {
      const name = current.slice(0, colon).trim().toLowerCase();
      let value = current.slice(colon + 1).trim();
      if (value.length > limits.maxHeaderValueChars) {
        value = value.slice(0, limits.maxHeaderValueChars);
        problems.add("header_value_truncated");
      }
      // The snapshot is a prefix of `current`, so the colon is at the same
      // index in both and the same slice recovers the value half.
      let firstLine = firstPhysicalLine === null ? value : firstPhysicalLine.slice(colon + 1).trim();
      if (firstLine.length > limits.maxHeaderValueChars) {
        firstLine = firstLine.slice(0, limits.maxHeaderValueChars);
      }
      // A header name is `printable US-ASCII except colon`. Anything else is a
      // continuation line the folding rules did not cover, or garbage.
      if (/^[\x21-\x39\x3b-\x7e]+$/.test(name)) headers.push({ name, value, folded, firstLine });
      else problems.add("malformed_header");
    } else if (current.trim()) {
      problems.add("malformed_header");
    }
    current = null;
    folded = false;
    firstPhysicalLine = null;
  };

  for (const line of block.split("\n")) {
    const stripped = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (headers.length >= limits.maxHeaderCount) {
      problems.add("header_count_capped");
      break;
    }
    if (stripped.startsWith(" ") || stripped.startsWith("\t")) {
      // A folded continuation. RFC 5322 §2.2.3: the CRLF is removed and the
      // leading whitespace is retained as a single space.
      if (current === null) problems.add("malformed_header");
      else {
        // Snapshot before the first extension, never after: the point is to
        // keep the line the MTA actually emitted, uncontaminated.
        if (!folded) firstPhysicalLine = current;
        current += ` ${stripped.trim()}`;
        folded = true;
      }
      continue;
    }
    flush();
    current = stripped;
  }
  flush();
  return headers;
}

function headerValue(headers: Header[], name: string): string {
  for (const header of headers) if (header.name === name) return header.value;
  return "";
}

/** Every value for a repeated header, in the order the message carried them. */
function headerValues(headers: Header[], name: string, limit: number): string[] {
  const out: string[] = [];
  for (const header of headers) {
    if (header.name !== name) continue;
    out.push(header.value);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Which of those values were assembled from folded continuation lines.
 *
 * Only the authentication headers care, and they care a great deal. The
 * sender's own headers begin immediately below the ones the MTA prepended, so a
 * message whose *first* header line starts with SP or HTAB has that line
 * appended — by correct RFC 5322 unfolding — to the last header the MTA wrote.
 * If that header is an authentication verdict, the sender has just written
 * into it.
 *
 * The result is one header, not two, so `verifySender`'s rule that a second
 * header bearing our authserv-id is fatal never fires: the attacker did not add
 * a header, they extended ours. Nor does a duplicate-clause check help, because
 * the attack works precisely when the MTA *omits* the method being forged —
 * there is no duplicate to notice.
 *
 * What closes it is `headerValuesFirstLine` below: a folded verdict is read
 * only as far as the line our MTA emitted, so the spliced clauses are never in
 * the string that gets parsed. This flag is the switch that selects it.
 */
function headerValuesFolded(headers: Header[], name: string, limit: number): boolean[] {
  const out: boolean[] = [];
  for (const header of headers) {
    if (header.name !== name) continue;
    out.push(header.folded);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The same values as `headerValues`, truncated at each header's first fold.
 *
 * Refusing every folded verdict is what the fold rule used to do, and it turned
 * out to refuse *our own MTA's* long header — Cloudflare folds its
 * `Authentication-Results`, so in production every capture was labelled
 * possibly-spoofed and the warning stopped meaning anything.
 *
 * This is the discriminator that replaced it, and it does not try to guess who
 * folded. It asks a question with an answer: **which bytes of this header did
 * our MTA certainly write?** Unfolding appends each continuation to what came
 * before, so a spliced-in line is always to the *right* of the first physical
 * line, and the first physical line is always exactly what the MTA emitted
 * before its own first CRLF. Reading only that is sound whoever folded — the
 * genuine long header keeps the clauses that fit on line one, and the forged
 * continuation is simply not there to read.
 */
function headerValuesFirstLine(headers: Header[], name: string, limit: number): string[] {
  const out: string[] = [];
  for (const header of headers) {
    if (header.name !== name) continue;
    out.push(header.firstLine);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Collect the `ARC-Authentication-Results` headers, each with the two facts
 * `./auth.ts` needs about it that its own text cannot tell you.
 *
 * `abovePrimary` is the important one and it is the whole reason this is not
 * just another `headerValues` call. See `ArcHeader.abovePrimary`.
 *
 * Unbounded on purpose — or rather, bounded by `limits.maxHeaderCount`, which
 * already applies. A cap here would create a truncation blind spot: a forged
 * duplicate pushed past the cap would vanish from the list `verifySender`
 * checks for ambiguity, and a check that cannot see the forgery is not a check.
 */
function collectArcHeaders(headers: Header[]): ArcHeader[] {
  const primary = headers.findIndex((header) => header.name === "authentication-results");
  const out: ArcHeader[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]!;
    if (header.name !== "arc-authentication-results") continue;
    out.push({
      value: header.value,
      folded: header.folded,
      abovePrimary: primary >= 0 && index < primary,
    });
  }
  return out;
}

/* ------------------------------- RFC 2047 --------------------------------- */

/**
 * An encoded-word. Bounded and backtracking-free by construction:
 *
 * - the charset token is a negated class capped at 64 characters;
 * - the encoded text is a negated class — an encoded-word may contain neither
 *   whitespace nor `?` — capped at 2048;
 * - there is no nested quantifier anywhere, so there is no input for which the
 *   engine has more than one way to match a given prefix.
 */
const ENCODED_WORD = /=\?([^?\s]{1,64})\?([BbQq])\?([^?\s]{0,2048})\?=/g;

/**
 * Decode RFC 2047 encoded-words in a header value.
 *
 * Returns the value unchanged when there are none, which is the overwhelmingly
 * common case and costs one `indexOf`.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  // RFC 2047 §6.2: whitespace *between* two adjacent encoded-words is not part
  // of the text and is dropped, so a word split across a fold rejoins cleanly.
  // Linear: both sides of the alternation are literals.
  const joined = value.replace(/\?=[ \t]+=\?/g, "?==?");
  ENCODED_WORD.lastIndex = 0;
  return joined.replace(ENCODED_WORD, (whole, charset: string, encoding: string, text: string) => {
    try {
      const bytes =
        encoding.toLowerCase() === "b" ? base64Decode(text) : quotedPrintableDecode(text, true);
      if (bytes === null) return whole;
      return decodeBytes(bytes, charset.split("*")[0]!);
    } catch {
      return whole;
    }
  });
}

/* --------------------------- transfer encodings --------------------------- */

/** Strict-ish base64 → bytes, or `null` when there is nothing usable. */
function base64Decode(value: string): Uint8Array | null {
  // Padding is dropped and recomputed rather than trusted: a part may be
  // several base64 chunks concatenated, a forward may have clipped the tail,
  // and `atob` rejects anything whose length is not a multiple of four. A
  // truncated part is common enough that decoding what is there beats
  // discarding the whole body.
  const core = value.replace(/[^A-Za-z0-9+/]/g, "");
  if (!core) return new Uint8Array(0);
  // A remainder of one cannot encode any whole byte, so that character goes.
  const usable = core.length % 4 === 1 ? core.slice(0, -1) : core;
  if (!usable) return new Uint8Array(0);
  const padding = usable.length % 4 === 0 ? "" : "=".repeat(4 - (usable.length % 4));
  try {
    return latin1Encode(atob(usable + padding));
  } catch {
    return null;
  }
}

/**
 * Quoted-printable → bytes.
 *
 * `underscoreIsSpace` is the RFC 2047 Q variant, where `_` stands for a space.
 * A hand-written scan rather than a regex: the soft-line-break rule (`=` at
 * end of line) and the "an invalid escape stays literal" rule are both easier
 * to get right, and to read, as a loop.
 */
function quotedPrintableDecode(value: string, underscoreIsSpace = false): Uint8Array {
  // Pre-sized, not a `number[]` grown by `push`.
  //
  // Output is never longer than input — every branch consumes at least one
  // character and emits at most one byte — so one allocation of `value.length`
  // is both sufficient and an upper bound. The array-of-numbers version cost
  // roughly 147 MB of heap for a 5 MB body, in a 128 MB isolate that concurrent
  // deliveries share. An OOM there is not the `parse_failed` this module
  // promises: the isolate dies and takes its neighbours with it.
  const out = new Uint8Array(value.length);
  let outLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "_" && underscoreIsSpace) {
      out[outLength++] = 0x20;
      continue;
    }
    if (char !== "=") {
      out[outLength++] = char.charCodeAt(0) & 0xff;
      continue;
    }
    const next = value[index + 1];
    if (next === "\n") {
      index += 1;
      continue;
    }
    if (next === "\r" && value[index + 2] === "\n") {
      index += 2;
      continue;
    }
    const hex = value.slice(index + 1, index + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out[outLength++] = parseInt(hex, 16);
      index += 2;
      continue;
    }
    // Not a valid escape. RFC 2045 says this is illegal; every real client
    // renders it literally, and so do we.
    out[outLength++] = 0x3d;
  }
  return out.subarray(0, outLength);
}

function decodeTransfer(body: string, encoding: string): Uint8Array {
  const normalized = encoding.toLowerCase().trim();
  if (normalized === "base64") return base64Decode(body) ?? new Uint8Array(0);
  if (normalized === "quoted-printable") return quotedPrintableDecode(body);
  return latin1Encode(body);
}

/* ------------------------------ content-type ------------------------------ */

export interface ContentType {
  /** Lowercased `type/subtype`. */
  type: string;
  params: Record<string, string>;
}

/**
 * Split a structured header value on `;` while respecting quoted-strings, so a
 * `filename="a;b.txt"` does not become two parameters.
 */
function splitParams(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      if (char === "\\" && index + 1 < value.length) {
        current += value[index + 1];
        index += 1;
        continue;
      }
      if (char === '"') quoted = false;
      else current += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ";") {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

/** Percent-decode an RFC 2231 extended value: `charset'lang'pct-encoded`. */
function decodeExtendedParam(value: string): string {
  const first = value.indexOf("'");
  if (first < 0) return value;
  const second = value.indexOf("'", first + 1);
  if (second < 0) return value;
  const charset = value.slice(0, first);
  const encoded = value.slice(second + 1);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === "%" && /^[0-9a-fA-F]{2}$/.test(encoded.slice(index + 1, index + 3))) {
      bytes.push(parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(encoded.charCodeAt(index) & 0xff);
  }
  return decodeBytes(Uint8Array.from(bytes), charset);
}

/**
 * The bare token of a `Content-Disposition`, lowercased, or "".
 *
 * Separate from `parseContentType` because a disposition is not a media type:
 * it has no `/`, so the media-type validator can only ever reject it.
 *
 * `splitParams` is the load-bearing half: the two callers compare the result
 * against `"attachment"`, and a real header is `attachment; filename=…` — or
 * `attachment; size=42`, or `attachment;` with nothing after it. Comparing the
 * whole value is how both guards came to be dead in the first place.
 */
function dispositionToken(value: string): string {
  const token = (splitParams(value)[0] || "").trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+$/.test(token) ? token : "";
}

/**
 * Parse a `Content-Type` / `Content-Disposition` value, resolving RFC 2231
 * continuations (`name*0`, `name*1`, …) and extended values (`name*`).
 */
export function parseContentType(value: string): ContentType {
  const pieces = splitParams(value);
  const type = (pieces[0] || "").trim().toLowerCase();

  // `Object.create(null)`, not `{}`: `rawKey` is attacker-controlled and is used
  // both as an `in` test and as an assignment target below. On a plain object
  // `"constructor" in plain` is true before anything is parsed, so the
  // first-wins rule would silently drop a real parameter, and `__proto__` is a
  // setter rather than a key. Neither is exploitable today — every consumer
  // reads a fixed name — but the same shape one file over crashed the gateway,
  // and a null-prototype bag costs nothing.
  const plain: Record<string, string> = Object.create(null);
  const extended = new Map<string, { parts: Map<number, string>; encoded: Set<number> }>();

  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const rawKey = piece.slice(0, eq).trim().toLowerCase();
    const rawValue = piece.slice(eq + 1).trim();
    if (!rawKey) continue;

    const continuation = /^([^*]+)\*(\d+)(\*?)$/.exec(rawKey);
    if (continuation) {
      const base = continuation[1]!;
      const index = Number(continuation[2]);
      if (!Number.isInteger(index) || index < 0 || index > 64) continue;
      let entry = extended.get(base);
      if (!entry) {
        entry = { parts: new Map(), encoded: new Set() };
        extended.set(base, entry);
      }
      entry.parts.set(index, rawValue);
      if (continuation[3]) entry.encoded.add(index);
      continue;
    }
    if (rawKey.endsWith("*")) {
      plain[rawKey.slice(0, -1)] = decodeExtendedParam(rawValue);
      continue;
    }
    if (!(rawKey in plain)) plain[rawKey] = decodeEncodedWords(rawValue);
  }

  for (const [base, entry] of extended) {
    const indices = [...entry.parts.keys()].sort((a, b) => a - b);
    let assembled = "";
    for (const index of indices) {
      const part = entry.parts.get(index)!;
      assembled += entry.encoded.has(index) ? decodeExtendedParam(part) : part;
    }
    // A continuation wins over a plain parameter of the same name: a sender
    // that supplies both is trying to make two readers disagree.
    plain[base] = assembled;
  }

  return { type: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "", params: plain };
}

/* ------------------------------- addresses -------------------------------- */

/**
 * The addr-spec out of an address header, and nothing else.
 *
 * The display name is deliberately discarded: `From: Seyi <mallory@example.net>`
 * is a legal header anyone may send, and rendering the display name as the
 * sender is how a capture ends up looking like it came from someone the owner
 * trusts. Callers get the address; ./note.ts renders only the address.
 */
export function addrSpec(value: string): string {
  // **Not decoded, and the last pair rather than the first.** Both halves were
  // one character short of the attack this function exists to stop.
  //
  // Encoded words were decoded first, so a base64 payload of
  // `<alice@example.com>` became the earliest angle-addr in the string. A
  // quoted display name may legally contain `<` and `>` too, so it needed no
  // encoding at all. Either way the display name supplied the brackets and the
  // first pair won — and this result is the string `senderIsAllowed` is
  // evaluated against. An addr-spec is ASCII, so it can never be an encoded
  // word; only the display name can, and skipping the decode is what stops it
  // reaching in here.
  //
  // RFC 5322's `name-addr` is `display-name angle-addr`, so the address is the
  // LAST bracketed pair; anything before it is display text.
  const raw = singleLine(value);
  // `From:` may carry several mailboxes. There is no honest way to attribute
  // one capture to one of them, and taking the first let an attacker put an
  // allow-listed address in front of their own.
  //
  // A comma INSIDE the quotes is not a list. `"Doe, Jane" <jane@x.test>` is
  // legal and is what Exchange emits for a directory entry, so refusing every
  // comma drops mail from an allow-listed corporate sender — which the first
  // version of this did, against a form this repository already asserts in
  // `ingestionPolicy.test.ts` and lists under Accepted in `parseEmailAddress`'s
  // docstring. An unquoted `Doe, Jane <j@x.test>` stays refused: it genuinely
  // parses as two mailboxes.
  let quoted = false;
  for (let at = 0; at < raw.length; at += 1) {
    const ch = raw[at];
    if (ch === "\\") {
      at += 1;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) return "";
  }
  // `[^<>]` — no nesting, no backtracking.
  const angled = [...raw.matchAll(/<([^<>]{0,320})>/g)];
  const candidate = angled.length ? angled[angled.length - 1]![1]! : raw;
  const cleaned = candidate.trim().replace(/^"|"$/g, "").trim();
  // One `@`, no whitespace, both sides non-empty. Anything else is not an
  // address we are willing to hand to a policy check.
  return /^[^\s@]{1,320}@[^\s@]{1,255}$/.test(cleaned) ? cleaned : "";
}

/* ------------------------------- the walk --------------------------------- */

interface Leaf {
  contentType: ContentType;
  disposition: string;
  filename: string;
  bytes: Uint8Array;
}

interface WalkState {
  limits: MimeLimits;
  problems: Set<string>;
  parts: number;
  leaves: Leaf[];
}

/**
 * Find the parts of a multipart body.
 *
 * A delimiter is `--boundary` at the start of a line; the closing delimiter is
 * `--boundary--`. Scanning with `indexOf` and checking the preceding character
 * keeps this linear in the body length no matter how the sender arranges the
 * boundary — including a boundary that also appears inside a part, which is
 * illegal and which real mail contains anyway.
 */
function splitMultipart(
  body: string,
  boundary: string,
  state: WalkState,
): string[] {
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  let searchFrom = 0;
  let openedAt = -1;

  while (searchFrom <= body.length) {
    const at = body.indexOf(delimiter, searchFrom);
    if (at < 0) break;
    const atLineStart = at === 0 || body[at - 1] === "\n";
    if (!atLineStart) {
      searchFrom = at + delimiter.length;
      continue;
    }
    const after = body.slice(at + delimiter.length, at + delimiter.length + 2);
    const closing = after.startsWith("--");
    // A delimiter line must end there. Anything else is a longer boundary that
    // merely starts with ours.
    const rest = closing ? after.slice(2) : after;
    if (rest && !rest.startsWith("\r") && !rest.startsWith("\n") && rest.trim() !== "") {
      searchFrom = at + delimiter.length;
      continue;
    }

    if (openedAt >= 0) {
      // Drop the CRLF that belongs to the delimiter, not to the part.
      let end = at;
      if (body[end - 1] === "\n") end -= 1;
      if (body[end - 1] === "\r") end -= 1;
      parts.push(body.slice(openedAt, end));
      if (parts.length >= state.limits.maxParts) {
        state.problems.add("part_count_capped");
        return parts;
      }
    }
    if (closing) return parts;

    let start = at + delimiter.length;
    if (body[start] === "\r") start += 1;
    if (body[start] === "\n") start += 1;
    openedAt = start;
    searchFrom = start;
  }

  if (openedAt >= 0) {
    // No closing delimiter. Truncated or malformed; keep what is there rather
    // than discarding a real message over a missing five bytes.
    state.problems.add("unterminated_multipart");
    parts.push(body.slice(openedAt));
  }
  return parts;
}

function walkEntity(source: string, depth: number, state: WalkState): void {
  state.parts += 1;
  if (state.parts > state.limits.maxParts) {
    state.problems.add("part_count_capped");
    return;
  }
  if (depth > state.limits.maxDepth) {
    state.problems.add("depth_capped");
    return;
  }

  const { head, body } = splitEntity(source);
  const headers = parseHeaders(head, state.limits, state.problems);
  const contentType = parseContentType(headerValue(headers, "content-type") || "text/plain");
  const dispositionRaw = parseContentType(headerValue(headers, "content-disposition"));
  // The params come from `parseContentType`; the token does NOT.
  //
  // A disposition is a bare token — `attachment`, `inline` — with no slash, so
  // `parseContentType`'s `type/subtype` validation rejected every one of them
  // and `type` was always "". That made both `leaf.disposition !== "attachment"`
  // tests below constant `true`, leaving only their `!leaf.filename` half doing
  // any work. Nothing caught it because every attachment fixture supplies a
  // filename; the case that escaped was an attached part with none, which won
  // inline selection and became the note body while also being dropped from the
  // attachment list.
  const disposition = dispositionToken(headerValue(headers, "content-disposition"));

  if (contentType.type.startsWith("multipart/")) {
    const boundary = contentType.params.boundary;
    if (!boundary || boundary.length > 200) {
      // A multipart with no usable boundary has no parts. Treating the body as
      // text would surface the raw MIME source as if it were the message.
      state.problems.add("multipart_without_boundary");
      return;
    }
    for (const part of splitMultipart(body, boundary, state)) {
      walkEntity(part, depth + 1, state);
      if (state.parts > state.limits.maxParts) return;
    }
    return;
  }

  if (contentType.type.startsWith("message/")) {
    // `message/rfc822` is a nested message; walk it so a forwarded mail's text
    // is still found. `message/external-body` and friends fall through to the
    // same walk and simply yield nothing — this parser never dereferences a
    // pointer to somewhere else.
    if (contentType.type === "message/rfc822") {
      walkEntity(body, depth + 1, state);
      return;
    }
  }

  const bytes = decodeTransfer(body, headerValue(headers, "content-transfer-encoding"));
  const filename = singleLine(
    dispositionRaw.params.filename || contentType.params.name || "",
  );
  state.leaves.push({ contentType, disposition, filename, bytes });
}

/* -------------------------------- filenames -------------------------------- */

/**
 * An attachment filename is attacker-chosen and is about to become part of an
 * object key in someone's bucket. Reduce it to a leaf name made of characters
 * that cannot mean anything to a path resolver.
 *
 * Returns `""` when nothing usable survives; callers name the object by its
 * content hash in that case rather than inventing a name.
 */
export function safeFilename(value: string, maxLength = 80): string {
  const leaf = singleLine(value).split(/[\\/]/).pop() || "";
  const cleaned = leaf
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    // Collapse runs of dots. Nothing here can traverse a path — the leaf has no
    // separator left — but a name still *containing* ".." invites a reader
    // (human or code) to conclude that traversal is possible, and a name is not
    // worth that argument.
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, maxLength);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "" : cleaned;
}

/* --------------------------------- entry ---------------------------------- */

/**
 * Parse a whole message. **Never throws.**
 *
 * `htmlToText` is injected rather than imported so this module stays free of
 * the HTML converter's own caps and so a caller can test the two independently.
 */
export function parseEmail(
  raw: Uint8Array,
  limits: MimeLimits,
  htmlToText: (html: string, maxChars: number) => string,
): ParsedEmail {
  const problems = new Set<string>();
  const empty: ParsedEmail = {
    subject: "",
    fromAddress: "",
    toAddress: "",
    date: "",
    messageId: "",
    text: "",
    textSource: "none",
    attachments: [],
    authenticationResults: [],
    authenticationResultsFolded: [],
    authenticationResultsFirstLine: [],
    arcAuthenticationResults: [],
    problems: [],
  };

  try {
    let bytes = raw;
    if (bytes.length > limits.maxRawBytes) {
      bytes = bytes.subarray(0, limits.maxRawBytes);
      problems.add("raw_truncated");
    }
    const source = latin1Decode(bytes);
    const { head } = splitEntity(source);
    const topHeaders = parseHeaders(head, limits, problems);

    const state: WalkState = { limits, problems, parts: 0, leaves: [] };
    walkEntity(source, 0, state);

    // Body selection. `text/plain` anywhere in the tree beats `text/html`
    // anywhere in the tree: a sender who wants their HTML rendered can send
    // HTML alone, and preferring plain text means the conservative converter
    // runs only when there is no alternative.
    let text = "";
    let textSource: ParsedEmail["textSource"] = "none";
    const inline = state.leaves.filter(
      (leaf) => leaf.disposition !== "attachment" && !leaf.filename,
    );
    const plain = inline.find((leaf) => leaf.contentType.type === "text/plain");
    const html = inline.find((leaf) => leaf.contentType.type === "text/html");

    if (plain) {
      text = decodeBytes(plain.bytes, plain.contentType.params.charset || "utf-8");
      textSource = "plain";
    } else if (html) {
      const source2 = decodeBytes(html.bytes, html.contentType.params.charset || "utf-8");
      if (source2.length > limits.maxHtmlChars) problems.add("html_truncated");
      text = htmlToText(source2.slice(0, limits.maxHtmlChars), limits.maxTextChars);
      textSource = "html";
    }

    if (text.length > limits.maxTextChars) {
      text = text.slice(0, limits.maxTextChars);
      problems.add("text_truncated");
    }
    // Normalise line endings and strip the control characters that would let a
    // sender move the cursor around inside a rendered note. Newlines and tabs
    // survive; nothing else in C0 does.
    text = text
      .replace(/\r\n?/g, "\n")
      .replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
        "",
      );

    const attachments: ParsedAttachment[] = [];
    for (const leaf of state.leaves) {
      if (leaf === plain || leaf === html) continue;
      const isText = leaf.contentType.type.startsWith("text/") && !leaf.filename;
      if (isText && leaf.disposition !== "attachment") continue;
      if (attachments.length >= limits.maxAttachments) {
        problems.add("attachment_count_capped");
        break;
      }
      const oversized = leaf.bytes.length > limits.maxAttachmentBytes;
      if (oversized) problems.add("attachment_size_capped");
      attachments.push({
        filename: safeFilename(leaf.filename),
        contentType: leaf.contentType.type || "application/octet-stream",
        bytes: oversized ? null : leaf.bytes,
        size: leaf.bytes.length,
      });
    }

    const messageIdRaw = singleLine(headerValue(topHeaders, "message-id"));
    const angled = /<([^<>\s]{1,512})>/.exec(messageIdRaw);

    return {
      subject: singleLine(decodeEncodedWords(headerValue(topHeaders, "subject"))),
      fromAddress: addrSpec(headerValue(topHeaders, "from")),
      toAddress: addrSpec(headerValue(topHeaders, "to")),
      date: singleLine(headerValue(topHeaders, "date")).slice(0, 128),
      messageId: (angled ? angled[1]! : messageIdRaw).slice(0, 512),
      text,
      textSource,
      attachments,
      authenticationResults: headerValues(topHeaders, "authentication-results", 10),
      authenticationResultsFolded: headerValuesFolded(topHeaders, "authentication-results", 10),
      authenticationResultsFirstLine: headerValuesFirstLine(
        topHeaders,
        "authentication-results",
        10,
      ),
      arcAuthenticationResults: collectArcHeaders(topHeaders),
      problems: [...problems].sort(),
    };
  } catch {
    // A parser that throws on hostile input is a parser that fails open: the
    // caller's `catch` is somewhere else and does something else. Hand back the
    // empty message with a tag instead, and let the caller refuse.
    return { ...empty, problems: ["parse_failed"] };
  }
}
