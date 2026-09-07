/**
 * Phase 2 of `docs/decisions/communications.md`, "Search must index messages,
 * and today's index cannot": a channel-day note is bundled Markdown, and
 * `NOTE_INDEX_CHAR_CAP` takes the first 2,048 characters of a note and
 * nothing else — which indexes a day's first two or three messages and
 * silently drops the rest.
 *
 * The fix decided there: **a channel-day note is indexed as one document per
 * message — `path#anchor` — not as one document per file.** The note stays
 * one file in the customer's bucket; the index — a disposable derivative,
 * CLAUDE.md non-negotiable 3 — holds a document per message, each capped
 * independently, with the containing note's path carried on every one of
 * them so visibility is decided once, at the file, and never per message
 * (CONTRACT.md's own rule for the index as a whole).
 *
 * This module owns exactly one question: given a note's path and its full,
 * uncapped text, what documents does it contribute to the index? Everything
 * about *how* those documents are stored, scored or filtered lives where it
 * already did — `indexer.js`'s `addDoc` takes the extra `notePath`/`anchor`/
 * `comms` fields this module produces, and `shards.js`'s sync loop is the one
 * caller, since v1 (`maintain.js`) is reached by nothing in production
 * (CONTRACT.md § v2's own note on that file).
 *
 * ## Why this reads the rendered file back rather than re-deriving from events
 *
 * The index is built from whatever `syncShardedIndex` fetches from the
 * bucket — the rendered Markdown, not the `CommunicationEvent` list that
 * produced it. So the split here works the same way `parseChannelDayNote`
 * already does in `packages/communications`: scan the rendered text for the
 * headings and fences the renderer wrote, never re-open a raw provider id
 * (there is none in the bucket to re-open — `anchors.js`'s whole argument is
 * that the provider's id is hashed and never written).
 *
 * ## The security property is inherited, not re-argued
 *
 * `packages/communications/src/note.js` documents at length why a heading is
 * only real when it appears **outside** a fence: a sender can write a line
 * that looks exactly like `### 09:00 · x · y {#msg-0000000000000000}` inside
 * their own message body, and treating it as a boundary would let a stranger
 * inject a fake message into somebody's index. This module reads the same
 * already-rendered, already-defanged file `parseChannelDayNote` reads, with
 * the same rule — a heading only counts when the scanner is not inside a
 * fence — so the property carries over rather than needing to be re-proven:
 * fence markers a sender wrote are already broken by `defangFence` at render
 * time, so `line.startsWith(FENCE_BEGIN)` can never be satisfied by anything
 * inside a real fence.
 */

import { FENCE_MARKER } from "../../../../packages/communications/src/note.js";
import { isChannelDayNotePath } from "../../../../packages/communications/src/paths.js";
import { NOTE_INDEX_CHAR_CAP } from "./maintain.js";

export { isChannelDayNotePath as isChannelDayIndexPath };

const HEADING_RE = /^###\s(.*)\s\{#(msg-[0-9a-f]+)\}\s*$/;
const THREAD_RE = /^##\s+Thread\s+—\s+(.*)$/;
const FENCE_BEGIN = `<!-- ${FENCE_MARKER} begin `;
const FENCE_END = `<!-- ${FENCE_MARKER} end `;

/** Just the frontmatter block as a flat string map — not a YAML parser, the
 * same "one block, `key: value` lines" reading `indexer.js`'s own
 * `extractFields` gives frontmatter, because a real parser is a dependency
 * this package does not take. */
function frontmatterOf(text) {
  const out = {};
  if (!text.startsWith("---\n")) return out;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return out;
  for (const line of text.slice(4, end).split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    let value = raw;
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    out[key] = String(value);
  }
  return out;
}

/**
 * Every message anchor in a channel-day note's rendered text, as its own
 * indexable sub-document.
 *
 * `[]` for content that does not parse as this shape at all — including
 * ciphertext. An encrypted note's stored body is frontmatter plus an opaque
 * blob (`encryption.js`), which holds no `### … {#msg-…}` heading, so this
 * yields nothing for the same reason the phase-1 rule holds for an ordinary
 * note: the index never learns a plaintext term to match on. That is stated
 * here as a produced fact of the format rather than left as an accident of
 * scoring.
 *
 * @param {string} path the channel-day note's own bucket path
 * @param {string} full the note's full, uncapped text
 * @returns {Array<{key: string, notePath: string, anchor: string,
 *   content: string, snippetText: string, title: string,
 *   comms: {channel: string|null, date: string|null, threadId: string|null,
 *     participants: string[]}}>}
 */
export function channelDaySubDocuments(path, full) {
  const text = typeof full === "string" ? full : "";
  const fm = frontmatterOf(text);
  const channel = typeof fm.channel === "string" && fm.channel ? fm.channel : null;
  const date = typeof fm.date === "string" && fm.date ? fm.date : null;
  const account = typeof fm.account === "string" && fm.account ? fm.account : null;

  let thread = "";
  let inFence = false;
  let current = null;
  const segments = [];

  const closeCurrent = () => {
    if (current) segments.push(current);
    current = null;
  };

  for (const line of text.split("\n")) {
    // Headings and thread markers are only ever real **outside** a fence —
    // see the module comment. Checked first, and only when `!inFence`, so a
    // sender's own look-alike line (necessarily inside the real fence around
    // their message) is never mistaken for one.
    if (!inFence) {
      const threadMatch = THREAD_RE.exec(line);
      if (threadMatch) {
        thread = threadMatch[1].trim();
        closeCurrent();
        continue;
      }
      const heading = HEADING_RE.exec(line);
      if (heading) {
        closeCurrent();
        current = { anchor: heading[2], summary: heading[1].trim(), thread, bodyLines: [], rawLines: [] };
        continue;
      }
    }
    if (current) current.rawLines.push(line);
    if (line.startsWith(FENCE_BEGIN)) {
      inFence = true;
      continue;
    }
    if (line.startsWith(FENCE_END)) {
      inFence = false;
      continue;
    }
    if (inFence && current) current.bodyLines.push(line);
  }
  closeCurrent();

  return segments.map((segment) => {
    // `renderMessage` writes `HH:MM · Sender · Subject`; the sender is
    // whichever of the two labels `renderMessage` actually used, so this
    // never re-derives one from raw event data this module never sees.
    const parts = segment.summary.split(" · ");
    const sender = parts.length >= 2 ? parts[1].trim() : null;
    const participants = [...new Set([account, sender].filter((p) => typeof p === "string" && p))];

    const bodyText = segment.bodyLines.join("\n").trim();
    // A fallback for a segment whose fence this scanner could not find (a
    // malformed or hand-edited note) — everything under the heading, so a
    // best-effort sub-document is indexed rather than none at all.
    const rawText = segment.rawLines.join("\n").trim();
    const snippetText = [segment.summary, bodyText || rawText].filter(Boolean).join("\n\n");
    // Capped **independently of every other message in the day** — the whole
    // point of a sub-document is that message fourteen gets its own budget
    // rather than sharing the day's single 2,048-character window.
    const content =
      snippetText.length > NOTE_INDEX_CHAR_CAP ? snippetText.slice(0, NOTE_INDEX_CHAR_CAP) : snippetText;

    return {
      key: `${path}#${segment.anchor}`,
      notePath: path,
      anchor: segment.anchor,
      content,
      // The full, uncapped text a snippet is cut from — the same rule an
      // ordinary note's snippet already follows (`visible.js`: cut from a
      // fresh read, never from index data).
      snippetText,
      title: segment.summary,
      comms: {
        channel,
        date,
        // The rendered thread label, not a hashed provider thread id: the
        // bucket never carries the raw id (`anchors.js`), so this is the
        // best-available "which thread" signal a re-read of the file can
        // recover. Documented in docs/decisions/search.md.
        threadId: segment.thread || null,
        participants,
      },
    };
  });
}

/**
 * The one document an ordinary note contributes: its own path as the key, its
 * text sliced to `NOTE_INDEX_CHAR_CAP`, exactly v1/v2's existing behaviour.
 */
function wholeNoteDocument(path, text) {
  const content = text.length > NOTE_INDEX_CHAR_CAP ? text.slice(0, NOTE_INDEX_CHAR_CAP) : text;
  return { key: path, notePath: path, anchor: null, content, comms: null };
}

/**
 * Every sub-document one note contributes to the index — one for an ordinary
 * note (its own path, uncapped text sliced to `NOTE_INDEX_CHAR_CAP`, exactly
 * v1/v2's existing behaviour), one per message anchor for a channel-day note.
 *
 * The one seam `shards.js`'s sync loop calls: it fetches `full` once per
 * stale note and hands it here, uncapped, so the per-note cap and the
 * per-message cap are never both applied to the same text.
 *
 * **Never the empty list.** A file at a channel-day path that holds no
 * message headings at all — an encrypted note, one somebody typed by hand in
 * Obsidian at `0-inbox/imessage/2026-09-07.md`, a render this scanner cannot
 * follow — falls back to the single whole-note document it would have
 * contributed before any of this existed. Answering `[]` was measured and is
 * two bugs rather than a conservative default:
 *
 * - **The diff never converges.** `docsByShard` records a note's version by
 *   `doc.notePath`, so a note with no docs has no version recorded, is stale
 *   on every subsequent listing, and is re-fetched and re-written forever —
 *   measured at one note GET plus a shard, manifest and docmap write **per
 *   pass, permanently**, with `touched` naming that note every time. A pass
 *   that "moved something" is also what keeps the control plane's projection
 *   chain going (`docs/decisions/search.md`, "A chain that cannot terminate
 *   is worse than no trigger at all"), so one such file bills a listing per
 *   link, 24 links per firing, forever.
 * - **The note becomes unsearchable.** A hand-written note at a channel-day
 *   path is an ordinary note that indexed fine yesterday; a shape recogniser
 *   deciding it contributes nothing is a silent recall loss in exactly the
 *   direction `toolSearchNotes`' miss copy exists to prevent.
 *
 * The fallback gives back the *old* behaviour for those files and no more:
 * an encrypted one still contributes no plaintext term (its bytes are
 * ciphertext, exactly as for every other encrypted note), and `visible.js`
 * still drops it at snippet time on `isEncryptedNote`.
 *
 * @param {string} path
 * @param {string} full uncapped note text
 * @returns {Array<{key: string, notePath: string, anchor: string|null,
 *   content: string, comms: object|null}>}
 */
export function subDocumentsFor(path, full) {
  const text = typeof full === "string" ? full : "";
  if (!isChannelDayNotePath(path)) return [wholeNoteDocument(path, text)];
  const messages = channelDaySubDocuments(path, text);
  return messages.length > 0 ? messages : [wholeNoteDocument(path, text)];
}

/**
 * One message's segment, read back out of a fresh copy of its note's text —
 * for the snippet a search result shows, which must be cut from a live read
 * and never from index data (`visible.js`'s existing rule for every note).
 *
 * `null` when the anchor no longer exists in the note — a legitimate race
 * (the day was regenerated between the index write and this read) treated
 * exactly like a hit whose note has gone: the caller drops it rather than
 * inventing a snippet.
 *
 * @param {string} notePath
 * @param {string} fullText
 * @param {string} anchor
 * @returns {{title: string, snippetText: string}|null}
 */
export function messageSegmentFor(notePath, fullText, anchor) {
  for (const segment of channelDaySubDocuments(notePath, fullText)) {
    if (segment.anchor === anchor) return { title: segment.title, snippetText: segment.snippetText };
  }
  return null;
}
