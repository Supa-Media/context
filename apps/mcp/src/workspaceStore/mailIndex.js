/**
 * Every note with mail in it, for the app's Mail page (the owner, 2026-11-25, approving the boards: "a mail icon
 * underneath the map that opens up in a full page view - and it can show special views for mail to bots, mail to
 * areas, and other regular notes").
 *
 * Mail is a ```mail block in a note's own Markdown (`packages/shared/src/mail.cjs`), in a mail folder's note
 * (`<area>/mail/<sender>.md`, `bots/<bot>/mail/<sender>.md`) or at the bottom of any note agents work on together.
 * Nothing names which notes those are, so this keeps a summary of each note's block beside the text it is read
 * from: how many messages, who joined, and the newest one. Like the facts (`facts.js`) it is a cache, read again
 * whenever a note's stored etag differs from the one it was read at, at the moment somebody asks; dropping the table
 * loses nothing.
 *
 * `{ask: "mail"}` answers the notes the reader may see that hold mail, newest message first, each `{path, count,
 * joined, apps, last}` where `last` is `{at, from, to, used, text}` with its text cut to `LAST_TEXT` and `apps` is the
 * app each sender signed with, by name (`builder` → `Claude Code · @seyi`), for its face on the list. A note the reader may
 * not see is never read for them. `complete: false` when more notes changed than one ask reads; the next ask reads on.
 */

import mail from "../../../../packages/shared/src/mail.cjs";
import { isWorkspaceObjectKey } from "./api.js";

const { parseMail } = mail;

/** Notes one ask reads again before it answers. */
export const MAIL_READ_BUDGET = 2_000;
/** Notes one answer names at most. */
export const MAIL_NOTES_CAP = 500;
/** Characters of the newest message an answer carries. */
export const LAST_TEXT = 280;
/** Names of who joined a note's mail, at most. */
const JOINED_CAP = 12;

const SCHEMA = ["CREATE TABLE IF NOT EXISTS ws_mail_index (key TEXT PRIMARY KEY, etag TEXT NOT NULL, summary TEXT)"];
const KEY = "COALESCE(r.storage_key, CASE WHEN r.note_id IS NULL THEN NULL ELSE 'notes/' || r.note_id || '.md' END)";
const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
/** A cheap look before a parse: a note without the fence has no mail. */
const FENCE = "```mail";

/** What a note's text says about its mail, or null when it holds none. */
export function mailSummaryOf(text) {
  if (typeof text !== "string" || !text.includes(FENCE)) return null;
  const { block, events } = parseMail(text);
  if (block === null) return null;
  const messages = events.filter((event) => event.kind === "mail");
  const joined = [...new Set(events.map((event) => event.from))].slice(0, JOINED_CAP);
  const newest = messages[messages.length - 1];
  // Each sender's newest app, so the list can draw an agent by its app (Claude's logo, and whose Claude it is).
  const apps = {};
  for (const event of events) if (event.app && joined.includes(event.from)) apps[event.from] = event.app;
  return {
    count: messages.length,
    joined,
    apps,
    last:
      newest === undefined
        ? null
        : { at: newest.at, from: newest.from, to: newest.to ?? null, used: newest.used ?? null, text: newest.text.length > LAST_TEXT ? `${newest.text.slice(0, LAST_TEXT - 1)}…` : newest.text },
  };
}

/** The mail half of a workspace object's facts. `sql` is its SQLite; `objects` its key store. */
export function workspaceMailIndex(sql, objects) {
  for (const statement of SCHEMA) sql.exec(statement);

  /** Live Markdown notes, later rows winning a path, with their stored etag and the one their summary was read at. */
  function notes() {
    const found = all(
      sql.exec(
        `SELECT r.path AS path, ${KEY} AS key, o.etag AS etag, m.etag AS indexed, m.summary AS summary
         FROM ws_rows r
         LEFT JOIN objects o ON o.key = ${KEY}
         LEFT JOIN ws_mail_index m ON m.key = ${KEY}
         WHERE r.gone = 0 AND r.kind = 'file' AND r.path LIKE '%.md'
         ORDER BY r.at`,
      ),
    );
    const byPath = new Map();
    for (const note of found) byPath.set(note.path, note);
    return byPath;
  }

  function read(note) {
    const found = objects.get(note.key, {});
    if (found === null || found.body === undefined) {
      sql.exec("DELETE FROM ws_mail_index WHERE key = ?", note.key);
      return null;
    }
    const summary = mailSummaryOf(new TextDecoder().decode(found.body));
    const json = summary === null ? null : JSON.stringify(summary);
    sql.exec(
      "INSERT INTO ws_mail_index (key, etag, summary) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, summary = excluded.summary",
      note.key,
      found.etag,
      json,
    );
    return json;
  }

  return {
    mail(_fields, sees) {
      let left = MAIL_READ_BUDGET;
      let complete = true;
      const out = [];
      for (const note of notes().values()) {
        if (typeof note.key !== "string" || !isWorkspaceObjectKey(note.key) || typeof note.etag !== "string") continue;
        // Judged before it is read, so a note the reader may not see is never read for them.
        if (!sees(note.path)) continue;
        let summary = note.summary;
        // A summary from before `apps` was kept is read again once, so the list's faces need no edit to the note.
        if (note.indexed !== note.etag || (typeof summary === "string" && !summary.includes('"apps":'))) {
          if (left === 0) {
            complete = false;
            continue;
          }
          left -= 1;
          summary = read(note);
        }
        if (typeof summary !== "string") continue;
        try {
          out.push({ path: note.path, ...JSON.parse(summary) });
        } catch {
          // A row this build cannot read is read again next time.
          sql.exec("DELETE FROM ws_mail_index WHERE key = ?", note.key);
        }
      }
      if (complete) sql.exec("DELETE FROM ws_mail_index WHERE key NOT IN (SELECT key FROM objects)");
      out.sort((a, b) => (b.last?.at ?? "").localeCompare(a.last?.at ?? "") || a.path.localeCompare(b.path));
      return { served: true, mail: out.slice(0, MAIL_NOTES_CAP), complete, more: out.length > MAIL_NOTES_CAP };
    },
  };
}
