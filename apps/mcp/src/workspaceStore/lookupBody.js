/**
 * A note's Markdown beside its row, in the one `ws.rows.lookup` an edit asks (`withBody`).
 *
 * Before: an edit to an existing note asked this object twice in a row before its merge, the row lookup and then the
 * body (`obj:ws.rows.lookup` then `obj:get`, production 2026-11-03: about 25 to 41 ms and 20 to 36 ms). The body is
 * the key the row names, read from this object's own SQLite, so it rides back on the lookup and the gateway's id
 * layer serves its `get` from it (`store/idLayout.js` `oneWrite`, `store/workspaceRouting.js` `storedFromLookup`).
 *
 * It adds nothing a reader could not already read: a body comes back only on a row the lookup itself answered
 * `found: true` for this reader (`canSee` by the reader's own rules, `serve.js` `lookUp`), on a live row (never a
 * gone one), only for a workspace note's own key (`notes/<noteId>.md`: never a Tex note's `tex/` key, never a folder),
 * only once the notes live here (home `object`), and only for a one-path lookup. Anything else answers the lookup as
 * before, and the gateway reads the body with a `get` of its own.
 */

import { HOMES } from "./api.js";

const NOTE_KEY = /^notes\/[A-Za-z0-9-]{1,128}\.md$/;

/** The largest body carried on a lookup; a larger note is read with its own `get`. */
export const LOOKUP_BODY_MAX = 1024 * 1024;

/** The body's text, or `null` where the bytes are not UTF-8 exactly as stored (kept byte for byte, a BOM included). */
function textOf(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes ?? new Uint8Array(0));
  } catch {
    return null;
  }
}

/**
 * The lookup's answer, with `body: {meta, text}` on its one found note where this object holds it.
 *
 * @param {{rows: object, objects?: object|null}} store the object's ready store
 * @param {{rows: object[]}} answer what `lookUp` answered
 * @param {{paths?: unknown, withBody?: unknown}} fields the call
 */
export function withLookupBody(store, answer, fields) {
  if (fields?.withBody !== true || !Array.isArray(fields.paths) || fields.paths.length !== 1) return answer;
  const { rows, objects } = store;
  if (!objects || typeof objects.get !== "function" || rows.home() !== HOMES.OBJECT) return answer;
  const [row] = answer.rows;
  if (row?.found !== true || row.path !== fields.paths[0] || row.kind === "folder" || typeof row.key !== "string" || !NOTE_KEY.test(row.key)) return answer;
  const stored = objects.get(row.key);
  if (stored === null || stored === undefined || stored.body === undefined || !(stored.size <= LOOKUP_BODY_MAX)) return answer;
  const text = textOf(stored.body);
  if (text === null) return answer;
  const { body: _bytes, ...meta } = stored;
  return { ...answer, rows: [{ ...row, body: { meta, text } }] };
}
