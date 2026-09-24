/**
 * The MIME entity tree walk: multipart splitting and recursive descent into
 * leaves.
 *
 * Split out of `../mime.ts`; see that file's docblock for the parser's threat
 * model.
 */

import type { MimeLimits } from "./limits";
import { splitEntity, parseHeaders, headerValue, singleLine } from "./headers";
import { parseContentType, dispositionToken, type ContentType } from "./contentType";
import { decodeTransfer } from "./transferEncoding";

export interface Leaf {
  contentType: ContentType;
  disposition: string;
  filename: string;
  bytes: Uint8Array;
}

export interface WalkState {
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

export function walkEntity(source: string, depth: number, state: WalkState): void {
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
