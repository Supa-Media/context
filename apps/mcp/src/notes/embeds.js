/** How `read_note` and `read_image` describe drawings and images a note embeds. Moved verbatim out of `src/index.js`. */

import { parseLinks } from "../links.js";

/**
 * Does this note reference this image?
 *
 * Deliberately broad: any mention of the leaf anywhere in the note. A stricter
 * definition — "must be a markdown image link" — is tempting and wrong here,
 * because these notes are edited in Obsidian, in rclone, in a text editor, by
 * people who will reformat a link without knowing it is load-bearing. The
 * failure mode of strict is an image that silently stops loading; the failure
 * mode of broad is that somebody who can already write a note can name a hash
 * they already know.
 *
 * That second one is worth stating plainly rather than pretending away: in a
 * content-addressed store the hash *is* the capability. Learning it requires
 * either seeing a note that references it or already holding the exact bytes.
 * Neither is a disclosure this tool creates, and the store is never listable,
 * so there is nowhere to learn a hash you were not already entitled to.
 */
export function noteReferencesImage(noteText, image) {
  return noteText.includes(image.leaf);
}

/** Base64 without a dependency, chunked so a large image cannot blow the stack. */
export function base64FromBytes(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The drawings a note embeds, as a header line.
 *
 * `![[plan.excalidraw]]` in a note is an image to Obsidian and four words to
 * everything else. A caller reading the note gets told the embed is a drawing
 * and what to read to find out what it shows — without which the most common
 * way a drawing appears in somebody's workspace is also the one way an agent
 * cannot follow.
 *
 * **In the header and not appended to the body**, which is the whole of the
 * design and was a bug first. Appended, it reads as part of the note: a client
 * that reads a note, edits a line and writes it back would have written
 * "Embedded drawings (read one…)" into the customer's file. That is the same
 * data-loss shape `toolWriteNote`'s drawing guard exists to stop, introduced by
 * the feature meant to be safe. The header block above the blank line is
 * already the established place for what is true *about* a note rather than in
 * it — `etag`, `path`, `visibility`, `encryption` — and every client already
 * treats it that way.
 *
 * Resolution is deliberately not attempted here. `parseLinks` already knows how
 * a target is written and `rewriteLinks` already keeps these pointing at the
 * right file when one moves (an `.excalidraw` suffix is ten characters, so it
 * falls past `resolveLink`'s eight-character extension test and correctly has
 * `.md` appended). What this adds is the one thing neither does: saying out
 * loud that the thing on the other end is a picture.
 */
export function drawingEmbedLine(text) {
  // Every note read passes through here, so the common answer is reached
  // without parsing anything: a note with no drawing in it cannot name one.
  if (!/excalidraw/i.test(text)) return "";

  const seen = new Set();
  for (const link of parseLinks(text)) {
    if (!link.embed) continue;
    const file = link.target.trim().split("#")[0];
    if (!/\.excalidraw(\.md)?$/i.test(file)) continue;
    seen.add(file.endsWith(".md") ? file : `${file}.md`);
  }
  if (seen.size === 0) return "";
  return `\nembedded drawings: ${[...seen].join(", ")}`;
}
