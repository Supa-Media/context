/**
 * Splits a message's text into plain words and links, for the chat page.
 *
 * Pure. A message is text from Tex or from the person, and it is drawn as
 * plain text, never as HTML. The only thing made tappable is an `https:` link,
 * because those are the links a person can trust to open a page. Anything else
 * (`http:`, `javascript:`, a bare domain) stays words.
 */

export type TextPiece = { kind: "text"; value: string } | { kind: "link"; value: string; href: string };

/** A web address, from `https://` to the first space, quote or angle bracket. */
const CANDIDATE = /https:\/\/[^\s<>"'`]+/gi;

/** Sentence punctuation after a link is the sentence's, not the link's. */
const TRAILING = /[.,;:!?)\]}]+$/;

/**
 * The `https:` href a candidate names, or `null` when it is not one. The URL
 * must parse, have a host, and carry no user name or password.
 */
export function httpsHref(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return candidate;
}

/** The text in pieces: each `https:` link on its own, the words around it as plain text. */
export function textPieces(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const value = raw.replace(TRAILING, "");
    const href = httpsHref(value);
    if (href === null) continue;
    if (start > at) pieces.push({ kind: "text", value: text.slice(at, start) });
    pieces.push({ kind: "link", value, href });
    // Whatever trailing punctuation was cut off stays as words after the link.
    at = start + value.length;
  }
  if (at < text.length) pieces.push({ kind: "text", value: text.slice(at) });
  return pieces;
}
