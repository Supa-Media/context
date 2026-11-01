/**
 * TEX'S DESK: what a person's texted turn reads before its model, in one call
 * to their Tex Durable Object (the owner, 2026-11-01: one copy in the object,
 * nothing read from storage on a text).
 *
 * The object answers the person's history record (`agent/history.js`) and,
 * by the keys that record keeps (`direct`), the notes every texted turn is
 * shown: About me and the jobs list (`agent/texDesk.js`). Only keys of notes
 * in this same object (`notes/<id>.md`), so a record can never point the
 * desk anywhere else; a key with nothing under it answers null, which the
 * turn reads the old way.
 */

/** The history record's key inside the object (`store/texRouting.js` maps `.context/agent/history/texts.json` here). */
export const DESK_HISTORY_KEY = "state/agent/history/texts.json";
/** The notes a desk may name: an id key of a note kept in this object. */
const NOTE_KEY = /^notes\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/;
/** The names of the notes a desk carries. */
export const DESK_NOTES = ["about", "jobs"];

const decoder = new TextDecoder();

/** One kept object as the desk answers it: `{etag, text}`, or null. */
function held(objects, key) {
  const found = objects.get(key);
  if (found === null || found.body === undefined) return null;
  return { etag: found.etag, text: decoder.decode(found.body) };
}

/**
 * The desk, from the object's own storage: `{history, notes}`. `history` is
 * the record (`{etag, text}`) or null; `notes[name]` is `{etag, text}`, false
 * when the record says there is no such note, or absent when the record names
 * no key (or one that is not this object's note, or one with nothing under it).
 */
export function readDesk(objects) {
  const history = held(objects, DESK_HISTORY_KEY);
  const notes = {};
  let direct = null;
  try {
    direct = history === null ? null : JSON.parse(history.text)?.direct ?? null;
  } catch {
    direct = null;
  }
  for (const name of DESK_NOTES) {
    const key = direct?.[name];
    if (key === false) notes[name] = false;
    else if (typeof key === "string" && NOTE_KEY.test(key)) {
      const note = held(objects, key);
      if (note !== null) notes[name] = note;
    }
  }
  return { history, notes };
}
