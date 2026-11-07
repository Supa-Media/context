/**
 * A CHAT'S HISTORY, AS ONE FILE IN ITS TEX FOLDER (the owner, 2026-11-02: "I think we should just have that ledger,
 * like be like a history file. Instead of a folder ... I just want people to be able to see it, like, okay, this is
 * exactly what Tex sees"; `docs/decisions/texting-assistant/tex-folders.md`).
 *
 * `history.ledger.json` (`tex/` for a person, the home for a group chat) is a row like any Tex note, and its key lives
 * in the chat's Tex object. The object keeps only a marker under that key, never a copy of the chat: a read of a key
 * holding the marker answers the chat's ledger (`ledger.js`) as it is now, `{manifest, view, entries}`, its newest
 * entries oldest first. One copy (the owner, 2026-11-01): the ledger is the chat's history, and this is a view of it.
 *
 * - **Read only.** A write over the marker is refused here, whoever sends it, and `write_note` refuses the path
 *   before that with words a model can act on (`agent/historyFile.js`).
 * - **Bounded.** The newest `VIEW_ENTRIES` entries, cut further to stay under `VIEW_BYTES`; `view.older` says more
 *   is kept. The whole ledger leaves with the person in Download as folders (`.context/tex/ledger/`), which skips
 *   this row so the chat is not exported twice.
 * - Its etag is the ledger's count and last change, so a reader holding the last answer is told nothing changed.
 */

import { TexObjectRefused } from "./objects.js";

/** What the object keeps under the history file's key: this, and nothing of the chat. */
export const HISTORY_VIEW_MARKER = '{"tex-history-view":1}';

/** The file's name, in a person's `tex/` and in each group chat's home. */
export const HISTORY_FILE = "history.ledger.json";

/** The most entries one read shows, and the most bytes. */
export const VIEW_ENTRIES = 1000;
export const VIEW_BYTES = 4 * 1024 * 1024;

/** A person's one-to-one chat (`agent/ledger.js` `ONE_TO_ONE_CHAT`). */
const ONE_TO_ONE = "texts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MARKER_BYTES = encoder.encode(HISTORY_VIEW_MARKER);

/** Whether these bytes are the marker. */
export function isHistoryMarker(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== MARKER_BYTES.byteLength) return false;
  return decoder.decode(bytes) === HISTORY_VIEW_MARKER;
}

/** The chat this object's history file shows: a person's one-to-one chat, else the object's one chat. */
function chatOf(ledger) {
  // A chat's conversation threads (`agent/conversationThreads.js`, `<chat>.threads`) are its index, not a second chat.
  const chats = ledger.chats().map((manifest) => manifest.chat).filter((chat) => !chat.endsWith(".threads"));
  if (chats.includes(ONE_TO_ONE)) return ONE_TO_ONE;
  return chats.length === 1 ? chats[0] : null;
}

/** The file's text and etag, from the ledger now. */
export function renderHistory(ledger) {
  const chat = ledger ? chatOf(ledger) : null;
  if (chat === null) {
    const empty = { manifest: null, view: { shown: 0, older: false }, entries: [] };
    return { text: `${JSON.stringify(empty, null, 2)}\n`, etag: "history-view-empty" };
  }
  const read = ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, limit: VIEW_ENTRIES });
  let entries = read.entries.slice().reverse();
  let older = read.before !== undefined;
  const textOf = (list) => `${JSON.stringify({ manifest: read.manifest, view: { shown: list.length, older }, entries: list }, null, 2)}\n`;
  let text = textOf(entries);
  while (encoder.encode(text).byteLength > VIEW_BYTES && entries.length > 0) {
    entries = entries.slice(Math.ceil(entries.length / 4));
    older = true;
    text = textOf(entries);
  }
  const manifest = read.manifest ?? {};
  return { text, etag: `history-view-${Number(manifest.count) || 0}-${Number(manifest.updated) || 0}-${entries.length}` };
}

/**
 * `objects` with the history file answered from the ledger: `get` and `head` of a key holding the marker answer the
 * view, and a `put` over it is refused unless it writes the marker again. Everything else as it was.
 */
export function withHistoryView(objects) {
  if (!objects?.ledger) return objects;
  const markerAt = (key) => {
    const meta = objects.head(key);
    if (meta === null || meta.size !== MARKER_BYTES.byteLength) return null;
    const found = objects.get(key);
    return found?.body && isHistoryMarker(found.body) ? meta : null;
  };
  const viewMeta = (meta, view, size) => ({ ...meta, etag: view.etag, size, httpMetadata: { contentType: "application/json" } });
  return {
    ...objects,
    head(key) {
      const meta = markerAt(key);
      if (meta === null) return objects.head(key);
      const view = renderHistory(objects.ledger);
      return viewMeta(meta, view, encoder.encode(view.text).byteLength);
    },
    get(key, options = {}) {
      const meta = markerAt(key);
      if (meta === null) return objects.get(key, options);
      const view = renderHistory(objects.ledger);
      const body = encoder.encode(view.text);
      const answer = viewMeta(meta, view, body.byteLength);
      const unchanged = options.onlyIf?.etagDoesNotMatch;
      if (typeof unchanged === "string" && unchanged.replace(/"/g, "") === view.etag) return answer;
      return { ...answer, body };
    },
    async put(key, value, options = {}) {
      if (markerAt(key) !== null) {
        const bytes = typeof value === "string" ? encoder.encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
        if (!isHistoryMarker(bytes)) throw new TexObjectRefused("the history file is a view of the chat's log and can't be written");
      }
      return await objects.put(key, value, options);
    },
  };
}
