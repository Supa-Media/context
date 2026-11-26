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
 * With `{read: path}` it is one conversation opened on the Mail page instead: the reader's read of that note's mail is
 * kept, and the answer is `{kind: "mailReads", path, reads: [{name, by, clientName, at}]}`, who has read it and when,
 * for its read receipts (`mail/reads.js`, `workspaceStore/mailReads.js`; Dev, 2026-11-26).
 *
 * Who may see each note is judged twice, as the folder notes route judges it: by the object, which reads and names
 * only what the reader may see, and here again with `canSee` over the rules the session reads.
 */

import { canSee } from "../privacy/engine.js";
import { json } from "../http/responses.js";
import { hasScope, SCOPE_READ } from "../session.js";
import { loadPrivacyState } from "../privacy/state.js";
import { objectReader } from "../store/objectLookup.js";
import { normalizePath } from "../notes/paths.js";
import { personalNameFor } from "../context/identity.js";

export const MAIL_NOTES_PATH = "/files/mail";

const MAX_BODY_BYTES = 1024;

const notServed = () => json({ error: "not_object" }, 409);

const MAX_PATH = 1024;

/** `{}` for the list, `{read: path}` for one conversation's receipts, or null for anything else. */
async function askOf(request) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES * 2) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return {};
  if (bytes.byteLength > MAX_BODY_BYTES * 2) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    const keys = Object.keys(body);
    if (keys.length === 0) return {};
    if (keys.length !== 1 || typeof body.read !== "string" || body.read.length > MAX_PATH || body.read.includes("\0")) return null;
    const path = normalizePath(body.read);
    return path ? { read: path } : null;
  } catch {
    return null;
  }
}

const MAX_READS = 50;

/** One receipt as the app reads it, or null. */
function readOf(read) {
  if (!read || (read.by !== "person" && read.by !== "ai") || typeof read.at !== "string") return null;
  return { name: word(read.name, 64), by: read.by, clientName: word(read.clientName, 120), at: read.at };
}

/** The reader's read of `path` kept, and who has read it: the conversation's receipts. */
async function receipts(path, store, session) {
  const reader = objectReader(store?.objectReading ?? {});
  if (reader === null || typeof reader.client?.mail?.reads !== "function") return notServed();
  const privacy = await loadPrivacyState(store);
  if (privacy.error) return json({ error: "unavailable" }, 503);
  // A note the session's rules hold back answers as a missing one does, before the object is asked anything.
  if (!canSee(path, session.scope, privacy.rules, privacy.overrides, session.grantedGroups)) return json({ error: "not_found" }, 404);
  const { client, judged, settledBehind } = reader;
  const name = personalNameFor(session);
  if (name !== null && typeof session.actorUserId === "string" && session.actorUserId !== "") {
    await client.mail.read({ path, by: "person", reader: `person:${session.actorUserId}`, name, ...judged }).catch(() => null);
  }
  const answer = await client.mail.reads({ path, ...judged }).catch(() => null);
  if (answer === null) return json({ error: "unavailable" }, 503);
  if (settledBehind(answer) || answer.served !== true) return notServed();
  if (answer.found !== true) return json({ error: "not_found" }, 404);
  const reads = (Array.isArray(answer.reads) ? answer.reads : []).map(readOf).filter((read) => read !== null).slice(0, MAX_READS);
  return json({ kind: "mailReads", path, reads });
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
  const apps = {};
  if (row.apps && typeof row.apps === "object" && !Array.isArray(row.apps)) {
    for (const name of joined) if (typeof row.apps[name] === "string" && row.apps[name].length <= 40) apps[name] = row.apps[name];
  }
  return { path: row.path, count: row.count, joined, apps, last };
}

/** Serves the Mail page's notes for `session` on `store`, the request's own store. */
export async function handleMailNotes(request, store, session) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!hasScope(session, SCOPE_READ)) return json({ error: "forbidden" }, 403);
  const asked = await askOf(request);
  if (asked === null) return json({ error: "invalid_request" }, 400);
  if (asked.read !== undefined) return receipts(asked.read, store, session);

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
