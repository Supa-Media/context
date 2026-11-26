/**
 * `POST /files/mail`: every note with mail in it that the reader may see, for the app's Mail page (the owner,
 * 2026-11-25: "a mail icon underneath the map that opens up in a full page view - and it can show special views for
 * mail to bots, mail to areas, and other regular notes"). Answered by the workspace's object (`workspaceStore/mailIndex.js`)
 * with no control plane on the way, the same road as a folder page's notes (`folderNotesRoute.js`).
 *
 * The answer is `{kind: "mailNotes", notes: [{path, count, joined, last}], complete}`, newest message first; `last`
 * carries the newest message's sender, recipient and first words, which the reader could read in the note itself.
 * What this route does not serve answers 409 `not_object`: a workspace whose notes are not in its object yet, one
 * behind on a change, a reader the object cannot judge. The app then shows mail folders only.
 *
 * Who may see each note is judged twice, as the folder notes route judges it: by the object, which reads and names
 * only what the reader may see, and here again with `canSee` over the rules the session reads.
 */

import { canSee } from "../privacy/engine.js";
import { json } from "../http/responses.js";
import { hasScope, SCOPE_READ } from "../session.js";
import { loadPrivacyState } from "../privacy/state.js";
import { objectReader } from "../store/objectLookup.js";

export const MAIL_NOTES_PATH = "/files/mail";

const MAX_BODY_BYTES = 1024;

const notServed = () => json({ error: "not_object" }, 409);

async function emptyBody(request) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return false;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return true;
  if (bytes.byteLength > MAX_BODY_BYTES) return false;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
  } catch {
    return false;
  }
}

const word = (value, max) => (typeof value === "string" && value.length <= max ? value : null);

/** One row as the app reads it, or null for one this build does not pass on. */
function rowOf(row) {
  if (!row || typeof row.path !== "string" || !Number.isFinite(row.count)) return null;
  const joined = Array.isArray(row.joined) ? row.joined.filter((name) => typeof name === "string" && name.length <= 64) : [];
  const last =
    row.last && typeof row.last === "object" && typeof row.last.at === "string" && typeof row.last.from === "string"
      ? { at: row.last.at, from: row.last.from, to: word(row.last.to, 64), used: Number.isFinite(row.last.used) ? row.last.used : null, text: word(row.last.text, 400) ?? "" }
      : null;
  return { path: row.path, count: row.count, joined, last };
}

/** Serves the Mail page's notes for `session` on `store`, the request's own store. */
export async function handleMailNotes(request, store, session) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!hasScope(session, SCOPE_READ)) return json({ error: "forbidden" }, 403);
  if (!(await emptyBody(request))) return json({ error: "invalid_request" }, 400);

  const reader = objectReader(store?.objectReading ?? {});
  if (reader === null || typeof reader.client.facts !== "function") return notServed();
  const { client, judged, settledBehind } = reader;

  const [privacy, answer] = await Promise.all([loadPrivacyState(store), client.facts({ ask: "mail", ...judged }).catch(() => null)]);
  if (privacy.error || answer === null) return json({ error: "unavailable" }, 503);
  if (settledBehind(answer)) return notServed();
  if (answer?.served !== true || !Array.isArray(answer.mail)) return notServed();
  const { rules, overrides } = privacy;
  const names = session.grantedGroups;

  const notes = [];
  for (const each of answer.mail) {
    const row = rowOf(each);
    if (row !== null && canSee(row.path, session.scope, rules, overrides, names)) notes.push(row);
  }
  return json({ kind: "mailNotes", notes, complete: answer.complete === true && answer.more !== true });
}
