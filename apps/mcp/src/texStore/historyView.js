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
import { foldThreads, listedThreads, THREADS_SUFFIX } from "../agent/conversationThreads.js";

/** What the object keeps under the history file's key: this, and nothing of the chat. */
export const HISTORY_VIEW_MARKER = '{"tex-history-view":1}';

/** The file's name, in a person's `tex/` and in each group chat's home. */
export const HISTORY_FILE = "history.ledger.json";

/**
 * The chat's conversations, as a second view beside it (Dev2, 2026-11-07: in the Tex folder, conversations is "a page
 * that you click on it and then you see the UI, similar to how history is"). The same kind of row, its own marker, and
 * a read answers the chat's conversation threads (`agent/conversationThreads.js`) as they stand now: an index of the
 * history, so never a copy of a word of it, read only, and left out of a download as the history view is.
 */
export const CONVERSATIONS_FILE = "conversations.ledger.json";
export const CONVERSATIONS_VIEW_MARKER = '{"tex-conversations-view":1}';
/** Threads one read of the conversations file shows, and the threads ledger pages it reads. */
const VIEW_THREADS = 500;
const THREAD_PAGES = 20;

/** The most entries one read shows, and the most bytes. */
export const VIEW_ENTRIES = 1000;
export const VIEW_BYTES = 4 * 1024 * 1024;

/** A person's one-to-one chat (`agent/ledger.js` `ONE_TO_ONE_CHAT`). */
const ONE_TO_ONE = "texts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MARKER_BYTES = encoder.encode(HISTORY_VIEW_MARKER);
const CONVERSATIONS_BYTES = encoder.encode(CONVERSATIONS_VIEW_MARKER);

/** Whether these bytes are the history marker. */
export function isHistoryMarker(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== MARKER_BYTES.byteLength) return false;
  return decoder.decode(bytes) === HISTORY_VIEW_MARKER;
}

/** Which view these bytes mark: `history`, `conversations`, or null for anything else. */
export function viewOfMarker(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (isHistoryMarker(bytes)) return "history";
  if (bytes.byteLength === CONVERSATIONS_BYTES.byteLength && decoder.decode(bytes) === CONVERSATIONS_VIEW_MARKER) return "conversations";
  return null;
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

/** The conversations file's text and etag: the chat's threads as they stand, open first. */
export function renderConversations(ledger) {
  const chat = ledger ? chatOf(ledger) : null;
  if (chat === null) return { text: `${JSON.stringify({ chat: null, view: { shown: 0, more: false }, threads: [] }, null, 2)}\n`, etag: "conversations-view-empty" };
  const entries = [];
  let after = null;
  let manifest = null;
  for (let page = 0; page < THREAD_PAGES; page += 1) {
    const read = ledger.read(`${chat}${THREADS_SUFFIX}`, { ...(after !== null ? { after } : {}) });
    manifest = read.manifest ?? manifest;
    entries.push(...(read.entries ?? []));
    if (!Number.isSafeInteger(read.next)) break;
    after = read.next;
  }
  const ordered = listedThreads(foldThreads(entries).threads, Number.MAX_SAFE_INTEGER);
  const threads = ordered.slice(0, VIEW_THREADS).map((t) => ({ id: t.id, title: t.title, description: t.description, status: t.status, started: t.at, last: t.last, texts: t.texts }));
  const text = `${JSON.stringify({ chat, view: { shown: threads.length, more: ordered.length > threads.length }, threads }, null, 2)}\n`;
  return { text, etag: `conversations-view-${Number(manifest?.count) || 0}-${Number(manifest?.updated) || 0}` };
}

/**
 * `objects` with the history file answered from the ledger: `get` and `head` of a key holding the marker answer the
 * view, and a `put` over it is refused unless it writes the marker again. Everything else as it was.
 */
export function withHistoryView(objects) {
  if (!objects?.ledger) return objects;
  const sizes = new Set([MARKER_BYTES.byteLength, CONVERSATIONS_BYTES.byteLength]);
  const markerAt = (key) => {
    const meta = objects.head(key);
    if (meta === null || !sizes.has(meta.size)) return null;
    const found = objects.get(key);
    const kind = found?.body ? viewOfMarker(found.body) : null;
    return kind === null ? null : { meta, kind };
  };
  const render = (kind) => (kind === "conversations" ? renderConversations(objects.ledger) : renderHistory(objects.ledger));
  const viewMeta = (meta, view, size) => ({ ...meta, etag: view.etag, size, httpMetadata: { contentType: "application/json" } });
  return {
    ...objects,
    head(key) {
      const marked = markerAt(key);
      if (marked === null) return objects.head(key);
      const view = render(marked.kind);
      return viewMeta(marked.meta, view, encoder.encode(view.text).byteLength);
    },
    get(key, options = {}) {
      const marked = markerAt(key);
      if (marked === null) return objects.get(key, options);
      const view = render(marked.kind);
      const body = encoder.encode(view.text);
      const answer = viewMeta(marked.meta, view, body.byteLength);
      const unchanged = options.onlyIf?.etagDoesNotMatch;
      if (typeof unchanged === "string" && unchanged.replace(/"/g, "") === view.etag) return answer;
      return { ...answer, body };
    },
    async put(key, value, options = {}) {
      const marked = markerAt(key);
      if (marked !== null) {
        const bytes = typeof value === "string" ? encoder.encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
        if (viewOfMarker(bytes) !== marked.kind) throw new TexObjectRefused(`the ${marked.kind} file is a view of the chat's log and can't be written`);
      }
      return await objects.put(key, value, options);
    },
  };
}
