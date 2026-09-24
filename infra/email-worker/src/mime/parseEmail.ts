/**
 * The parser's entry point: a whole message in, a `ParsedEmail` out, never a
 * throw.
 *
 * Split out of `../mime.ts`; see that file's docblock for the parser's threat
 * model and its deliberate omissions.
 */

import type { MimeLimits } from "./limits";
import { latin1Decode, decodeBytes } from "./bytes";
import {
  splitEntity,
  parseHeaders,
  headerValue,
  headerValues,
  headerValuesFolded,
  headerValuesFirstLine,
  collectArcHeaders,
  singleLine,
  type ArcHeader,
} from "./headers";
import { decodeEncodedWords } from "./encodedWords";
import { addrSpec } from "./address";
import { walkEntity, type WalkState } from "./walk";
import { safeFilename } from "./filename";

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
   * information ../auth.ts depends on. See `verifySender`.
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
   * `../auth.ts` reads this instead of the whole value when the header arrived
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
   * still carries what the first receiver saw. `../auth.ts` decides, very
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
