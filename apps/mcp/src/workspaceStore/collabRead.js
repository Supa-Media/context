/**
 * `ws.collab.read`: a note's Markdown and its editing history's current text, read inside the workspace object in one
 * call, for `read_note` (`tools/notes/read.js`).
 *
 * From the gateway a read of a note that people have edited together was the row lookup, then the Markdown beside the
 * history's head, then the document's state, then its current revision: three trips to this object after the lookup,
 * each waiting on the one before (production, 2026-11-03: fetch's median was 571 ms against its 150 ms bar). Here they
 * are local reads of the object's own SQLite, and the gateway waits for one call.
 *
 * The engine (`@context/collaboration` `readDocumentIfStarted`) is the same code over the same keys as
 * `ws.collab.replace` uses (`collabReplace.js` `engineStore`), so the answer is the one the gateway would have drawn.
 * A read can still write (a pending save finished, a head stamped with its note id); every write is handed back for
 * the bucket's backup copy, as a save's are.
 *
 * Nothing here judges who is reading: the gateway has already looked the path up for that reader and found the note
 * there, and asks only then. The object checks that the live row at the path is still the note the gateway resolved
 * (same key and note id), so a move or trash in between answers `{served: false}`, never another note's words.
 *
 * With `start: true` (the app opening a note to edit it, `live/noteReadRoute.js`) a note nothing has edited together
 * yet has its editing history started here, as the engine's `readDocument` starts one, so the editor gets the
 * document's version and edits it live from the first keystroke. Without it a read starts nothing, as `read_note` asks.
 *
 * Served only where the object holds everything the engine may read (home `object`, backfilled). Anything else, the
 * Markdown missing here, or a saved version this object no longer keeps, answers `{served: false}` and the gateway
 * reads as before. A password-encrypted note or one collaboration does not cover is answered with its Markdown alone,
 * as the gateway would never have asked the engine for it.
 */

import { CollaborationError, eligible, readDocument, readDocumentIfStarted } from "@context/collaboration";
import { isEncryptedNote } from "../encryption/format.js";
import { HOMES } from "./api.js";
import { engineStore, notHeldHere } from "./collabReplace.js";

const NOTE_KEY = /^notes\/[A-Za-z0-9-]{1,128}\.md$/;
const NOTE_ID = /^[A-Za-z0-9-]{1,128}$/;

/** The live row at `path` with its note id and key, from the object's own rows. */
function liveNoteAt(sql, path) {
  const cursor = sql.exec("SELECT note_id, storage_key FROM ws_rows WHERE path = ? AND gone = 0 ORDER BY id LIMIT 1", path);
  const row = typeof cursor?.toArray === "function" ? cursor.toArray()[0] : undefined;
  return row ? { noteId: row.note_id ?? null, key: row.storage_key ?? null } : null;
}

/** The Markdown held at `key`, as the answer carries it, or `null`. */
function markdownAt(objects, key) {
  const stored = objects.get(key);
  if (stored === null) return null;
  return { etag: stored.etag, size: stored.size, text: new TextDecoder().decode(stored.body ?? new Uint8Array(0)) };
}

/**
 * Serve one read. `store` is the object's ready store (`{rows, sql, objects}`); `fields` is `{path, key, noteId}` as
 * the gateway's lookup resolved them. The answer is `{served: true, markdown: {etag, size, text}, collaboration:
 * {documentId, etag, text} | null, writes, deletes}`, `{served: true, error: {code, message}, ...}` when the engine
 * refuses (the gateway fails closed, as it did), or `{served: false, reason, writes?, deletes?}`.
 */
export async function serveCollabRead(store, fields) {
  // The object's own clock, which moves only across its awaits: the call's time inside, without the trip.
  const started = Date.now();
  const timed = (answer) => ({ ...answer, took: Date.now() - started });
  const { path, key, noteId } = fields ?? {};
  if (typeof path !== "string" || typeof key !== "string" || !NOTE_KEY.test(key) || typeof noteId !== "string" || !NOTE_ID.test(noteId)) {
    return { served: false, reason: "bad_call" };
  }
  const { rows, sql, objects } = store;
  if (!sql || !objects || rows.home() !== HOMES.OBJECT || typeof rows.backfilledAt() !== "number") {
    return { served: false, reason: "not_held" };
  }
  const live = liveNoteAt(sql, path);
  if (live === null || live.key !== key || live.noteId !== noteId) return { served: false, reason: "row_moved" };
  const markdown = markdownAt(objects, key);
  if (markdown === null) return { served: false, reason: "not_held" };
  // What the gateway would not have asked the engine for: answered as the Markdown it is.
  if (isEncryptedNote(markdown.text) || !eligible(path, markdown.text)) {
    return timed({ served: true, markdown, collaboration: null, writes: [], deletes: [] });
  }

  const engine = engineStore(objects, { path, key, noteId });
  const handedBack = () => ({ writes: engine.writes, deletes: engine.deletes });
  try {
    const document = fields.start === true ? await readDocument(engine.store, path) : await readDocumentIfStarted(engine.store, path);
    // A read that finished a pending save wrote the Markdown: the answer carries what is there now.
    const current = engine.writes.some((write) => write.key === key) ? markdownAt(objects, key) : markdown;
    if (current === null) return timed({ served: false, reason: "not_held", ...handedBack() });
    // `whole: true` (the editor's live read, `live/collaborationRoute.js`) carries the document as the engine answers
    // it, its snapshot included, which the editor merges from; any other read only its identity, version and text.
    const collaboration = document === null ? null : fields.whole === true ? document : { documentId: document.documentId, etag: document.etag, text: document.text };
    return timed({ served: true, markdown: current, collaboration, ...handedBack() });
  } catch (error) {
    if (notHeldHere(error)) return timed({ served: false, reason: "not_held", ...handedBack() });
    if (error instanceof CollaborationError) return timed({ served: true, error: { code: error.code, message: error.message }, ...handedBack() });
    throw error;
  }
}
