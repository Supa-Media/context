/**
 * Writing a drawing back, without becoming the thing that corrupts it.
 *
 * ## The rule this is built around
 *
 * **Edit the file, never regenerate it.** Everything else here reads
 * `.excalidraw.md` and returns a description of it; this is the one module that
 * produces bytes somebody's bucket will hold, and it is therefore the one place
 * where a misunderstanding of the format is destructive rather than merely
 * unhelpful. `docs/decisions/obsidian-plugins.md` already refuses the
 * regenerating shape for exactly this reason: "a file we do not parse is still
 * a file we do not corrupt."
 *
 * So `serializeDrawing` starts from the **original file text** and splices in
 * only the two spans that the drawing actually changed — the `Text Elements`
 * block and the payload fence. The frontmatter, the plugin's warning line, the
 * `Excalidraw Data` heading, the `%%` wrapper, the `Element Links` and
 * `Embedded Files` sections, a `tags:` key somebody added by hand, a heading
 * this parser has never heard of, the trailing newline, even CRLF — all of it
 * survives because none of it is rewritten. A serializer that rebuilt the file
 * from a template would silently drop every one of those, and the customer
 * would find out in Obsidian.
 *
 * That is also why there is no "create a drawing from nothing" export here. The
 * plugin writes the scaffolding, with a warning line whose exact wording is its
 * own; inventing our own version of that is how two producers of one format
 * start to disagree. A new drawing is created by the editor that owns the
 * format, and this edits what comes back.
 *
 * ## The fence language is the customer's choice, not ours
 *
 * A payload arrives as ```compressed-json or ```json depending on a plugin
 * *setting*. Writing back in the other one would be a silent settings change
 * that shows up as an enormous diff in their sync client — so the language a
 * file arrived in is the language it leaves in, and `compressed` is read from
 * the parse rather than decided here.
 *
 * ## What a caller must have done first
 *
 * `serializeDrawing` takes the text it is editing, so the caller must be
 * holding the current file — which is the same etag discipline every other
 * write in this product follows. It does not read, it does not fetch, and it
 * refuses rather than guesses when the text it is given is not a drawing it
 * recognises: `null` back, and the caller writes nothing.
 */

import { compressToBase64, decompressFromBase64 } from "./lzstring.js";
import { parseDrawing, payloadFence, textElementsSpan } from "./excalidraw.js";

/**
 * How the plugin wraps a long base64 payload.
 *
 * Cosmetic to a parser and not cosmetic to a diff: an unwrapped payload is one
 * enormous line, so every edit shows as "the whole file changed" in git and in
 * any sync client that shows changes. Matching the plugin's wrapping keeps a
 * drawing's history readable by whatever the customer already uses.
 */
const WRAP_COLUMNS = 64;

/**
 * The new file body for `elements`, or `null` if `original` is not a drawing
 * this can edit safely.
 *
 * `null` is returned rather than a best effort for a missing payload, an
 * unreadable one, or a file with no `Text Elements` section to replace: in
 * every one of those the splice points are unknown, and writing anyway means
 * guessing where somebody's data goes.
 */
export function serializeDrawing(original, elements, { appState = null, files = null } = {}) {
  if (typeof original !== "string" || !Array.isArray(elements)) return null;

  const payload = findPayloadSpan(original);
  if (!payload) return null;

  // The scene object keeps the keys the plugin wrote, so a field this code has
  // never heard of — a future Excalidraw version's — is carried through rather
  // than dropped. Only `elements` (and `appState`/`files` when given) change.
  const existing = readScene(original, payload);
  if (!existing) return null;

  const scene = {
    ...existing,
    elements,
    ...(appState ? { appState: { ...existing.appState, ...appState } } : {}),
    ...(files ? { files } : {}),
  };

  const json = JSON.stringify(scene);
  const body = payload.compressed ? wrap(compressToBase64(json), WRAP_COLUMNS) : json;

  // Payload first, text second: splicing the earlier span first would move the
  // later one's offsets out from under it.
  let out = original.slice(0, payload.start) + body + original.slice(payload.end);

  const labels = renderTextElements(elements);
  const span = textElementsSpan(out);
  if (span) out = out.slice(0, span.start) + labels + out.slice(span.end);

  return out;
}

/**
 * Is writing `elements` over `original` safe?
 *
 * The question a caller asks before offering somebody a save button, so the
 * refusal is a disabled control rather than an error after the fact.
 */
export function canSerializeDrawing(original) {
  return serializeDrawing(original, []) !== null;
}

/* -------------------------------- the spans ------------------------------- */

/**
 * Where the payload sits inside the file, as offsets rather than as text.
 *
 * `findPayload` in `excalidraw.js` answers what the payload *is*; this answers
 * where it is, which is what a splice needs and what a reader does not. The two
 * find the same fence by the same rule — the duplication is one regex, and the
 * alternative (returning offsets from the reader) would put splice mechanics in
 * front of every caller that only wants to read.
 */
function findPayloadSpan(text) {
  // `payloadFence` rather than a second regex: the reader and the writer have
  // to agree about which fence is the payload, and when this file kept its own
  // copy they did not — a fence inside a text label was the payload to both,
  // so an edit was spliced into somebody's label while their real drawing kept
  // its old contents. One locator, one answer.
  const opener = payloadFence(text);
  if (!opener) return null;
  const start = opener.start;
  const close = text.indexOf("\n```", start - 1);
  /*
    An unterminated fence, and an honestly-labelled backstop: with this line
    removed nothing changes, because `end` is then 0, the slice `readScene`
    takes is empty, and an empty payload is refused there instead. Sabotaging
    it alone turns nothing red — that is the expected result, recorded rather
    than papered over. It earns its keep by making the refusal happen where the
    reason is legible, and by holding if `readScene` ever stops being the thing
    that reads the span. (`imageRefFor` in the gateway carries the same kind of
    line, with the same admission.)
  */
  if (close === -1) return null;
  return { compressed: opener.compressed, start, end: close + 1 };
}

/**
 * The scene object currently in the file, or null.
 *
 * Read through `parseDrawing` rather than re-decoding here, so "can this file
 * be read" and "can this file be written" can never disagree — a file the
 * reader refuses is a file the writer must refuse too.
 */
function readScene(text, payload) {
  const drawing = parseDrawing(text);
  if (!drawing.elements) return null;

  const raw = text.slice(payload.start, payload.end);
  const json = payload.compressed ? decompressFromBase64(raw) : raw;
  if (json === null) return null;
  try {
    const scene = JSON.parse(json);
    return scene && typeof scene === "object" ? scene : null;
  } catch {
    return null;
  }
}

/**
 * The `Text Elements` block for these elements.
 *
 * The plugin's own shape: the text, a space, `^` and the element's id, with a
 * blank line between entries so a label containing a newline stays one entry.
 * A container's label is included — it is a text element like any other, and
 * the block is what makes a drawing's words findable by a plain vault search,
 * which is the reason the plugin writes it at all.
 */
function renderTextElements(elements) {
  const entries = [];
  for (const element of elements) {
    if (!element || element.type !== "text" || element.isDeleted) continue;
    const text = typeof element.text === "string" ? element.text.trim() : "";
    if (!text) continue;
    entries.push(element.id ? `${text} ^${element.id}` : text);
  }
  return entries.length === 0 ? "\n" : `${entries.join("\n\n")}\n\n`;
}

/** Break a long base64 run across lines, the way the plugin stores it. */
function wrap(value, columns) {
  const lines = [];
  for (let i = 0; i < value.length; i += columns) lines.push(value.slice(i, i + columns));
  return `${lines.join("\n")}\n`;
}
