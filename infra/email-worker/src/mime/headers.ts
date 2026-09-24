/**
 * Header block splitting, folding, and the `Authentication-Results` /
 * `ARC-Authentication-Results` collection the auth verifier depends on.
 *
 * Split out of `../mime.ts`; see that file's docblock for the parser's threat
 * model.
 */

import type { MimeLimits } from "./limits";

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

export interface Header {
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

/**
 * Split an entity at the first empty line: RFC 5322 says the header block ends
 * there and everything after is the body, whatever it looks like.
 *
 * A message with no empty line at all is all headers and an empty body. That is
 * the right reading — and notably not "treat the whole thing as a body", which
 * would let a sender hide a payload from every header-based check.
 */
export function splitEntity(source: string): { head: string; body: string } {
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

export function parseHeaders(head: string, limits: MimeLimits, problems: Set<string>): Header[] {
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

export function headerValue(headers: Header[], name: string): string {
  for (const header of headers) if (header.name === name) return header.value;
  return "";
}

/** Every value for a repeated header, in the order the message carried them. */
export function headerValues(headers: Header[], name: string, limit: number): string[] {
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
export function headerValuesFolded(headers: Header[], name: string, limit: number): boolean[] {
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
export function headerValuesFirstLine(headers: Header[], name: string, limit: number): string[] {
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
 * `../auth.ts` needs about it that its own text cannot tell you.
 *
 * `abovePrimary` is the important one and it is the whole reason this is not
 * just another `headerValues` call. See `ArcHeader.abovePrimary`.
 *
 * Unbounded on purpose — or rather, bounded by `limits.maxHeaderCount`, which
 * already applies. A cap here would create a truncation blind spot: a forged
 * duplicate pushed past the cap would vanish from the list `verifySender`
 * checks for ambiguity, and a check that cannot see the forgery is not a check.
 */
export function collectArcHeaders(headers: Header[]): ArcHeader[] {
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
