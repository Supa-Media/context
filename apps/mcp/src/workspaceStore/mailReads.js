/**
 * WHO HAS READ A NOTE'S MAIL (Dev, 2026-11-26: "show read receipts whenever an agent reads a mail", then "whenever a
 * mail is read"). Kept in the workspace's own object beside the note, one row per reader per note: the last time that
 * reader read it. A reader is a person in the app (opening the note or its Agent Mail thread) or an AI client reading
 * the note or its mail over MCP, named as it would sign mail: a person by `@handle`, an AI client by the name it
 * registered and the `@handle` of the person whose client it is.
 *
 * Only a note whose text has a mail block is recorded; any other read writes nothing. The Agent Mail page asks for a
 * note's rows (`ws.mail.reads`) and draws each reader's receipt under the newest message it had read by then
 * (`apps/mobile/features/console/mailPage/receipts.ts`). Both are judged as a read is (`mailOps.js`): only a reader
 * who may see the note records or sees its receipts. Disposable: losing it loses only the receipts.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_mail_reads (note TEXT NOT NULL, reader TEXT NOT NULL, name TEXT, by TEXT NOT NULL, client_name TEXT, at INTEGER NOT NULL, PRIMARY KEY (note, reader))`,
];

/** A person in the app, or an AI client. */
export const READERS = Object.freeze(["person", "ai"]);
/** The most readers one note answers with, newest first. */
export const MAX_READERS = 50;

const isHandle = (value) => typeof value === "string" && /^@[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const isKey = (value) => typeof value === "string" && value.length > 0 && value.length <= 300;
const isClientName = (value) => typeof value === "string" && value.length > 0 && value.length <= 120;
const rowsOf = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** Whether a note's Markdown has a mail block: only such a note keeps receipts. */
export const hasMailBlock = (text) => typeof text === "string" && /^ {0,3}```mail\s*$/m.test(text);

/** The reads table over a Durable Object's `sql`. `now` is a clock, for the tests. */
export function mailReads(sql, { now = () => Date.now() } = {}) {
  let ready = false;
  const schema = () => {
    if (ready) return;
    for (const statement of SCHEMA) sql.exec(statement);
    ready = true;
  };
  return {
    /**
     * One read of `note` (its row id) by `reader`, a key the gateway composes (who and which client). Returns false
     * for a read it refuses to keep, so a malformed one never fails the read it rides on.
     */
    record(note, { reader, name = null, by, clientName = null }) {
      if (!isKey(note) || !isKey(reader) || !READERS.includes(by)) return false;
      if (name !== null && !isHandle(name)) return false;
      if (clientName !== null && !isClientName(clientName)) return false;
      if (by === "person" && name === null) return false;
      schema();
      sql.exec(
        "INSERT INTO ws_mail_reads (note, reader, name, by, client_name, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (note, reader) DO UPDATE SET name = excluded.name, client_name = excluded.client_name, at = excluded.at",
        note, reader, name, by, clientName, now(),
      );
      return true;
    },

    /** The note's readers, newest read first: `{name, by, clientName, at}` with `at` an ISO time. */
    of(note) {
      if (!isKey(note)) return [];
      schema();
      return rowsOf(sql.exec("SELECT name, by, client_name, at FROM ws_mail_reads WHERE note = ? ORDER BY at DESC LIMIT ?", note, MAX_READERS)).map((row) => ({
        name: row.name ?? null,
        by: row.by,
        clientName: row.client_name ?? null,
        at: new Date(Number(row.at)).toISOString(),
      }));
    },
  };
}
