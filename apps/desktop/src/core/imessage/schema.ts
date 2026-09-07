/**
 * The SQL this app runs against `chat.db`, and the shape it reads back.
 *
 * Every column Apple's schema stores as a `BLOB` or a 64-bit `INTEGER` is cast
 * to `TEXT` (or hex-encoded) **in the query**, not after: `sqlite3 -json`
 * mangles a raw `BLOB` into an unusable escape sequence, and a `date` column
 * printed as a bare JSON number loses precision the moment `JSON.parse` turns
 * it into a 64-bit float (see `appleTime.ts`'s header for the measurement).
 * Fixing either after the fact is fixing something that already happened —
 * these queries are the one place it can be prevented.
 *
 * **No value derived from message content is ever spliced into SQL text.**
 * Every query below is a fixed string; the only things interpolated into it
 * are a cursor and a date-range bound, both validated as plain digit strings
 * before they are used — never a chat name, a handle, a subject or anything
 * else a sender's own device chose the bytes of. The two queries that would
 * otherwise need one (participants, attachments) are instead run **unfiltered**
 * and joined against the message window in JavaScript; see `messageWindowSql`.
 *
 * This module builds SQL text and describes rows. It does not run anything —
 * see `sqlite.ts` for the one place a query actually reaches `/usr/bin/sqlite3`.
 */

/** A page of messages: either "everything new since this cursor" or "everything on this UTC day". */
export type MessageWindow =
  | { kind: "since"; afterRowId: number }
  | { kind: "day"; startNs: string; endNs: string };

/** A string of decimal digits only — what a validated cursor or Apple-epoch bound must look like. */
function digits(value: string): string {
  if (!/^\d+$/.test(value)) throw new TypeError(`not a digit string: ${JSON.stringify(value)}`);
  return value;
}

/** The `WHERE` fragment for one window, over `message.ROWID` / `message.date`. */
function messageWindowSql(window: MessageWindow): string {
  if (window.kind === "since") {
    if (!Number.isSafeInteger(window.afterRowId) || window.afterRowId < 0) {
      throw new TypeError(`not a valid ROWID cursor: ${window.afterRowId}`);
    }
    return `message.ROWID > ${window.afterRowId}`;
  }
  return `message.date >= ${digits(window.startNs)} AND message.date < ${digits(window.endNs)}`;
}

/**
 * One row of one message, joined to its chat and its sender.
 *
 * `associated_message_type` and `associated_message_guid` are how macOS
 * represents a tapback ("loved", "liked", …): a nonzero type means this row
 * IS a reaction rather than a message, and the guid it names is (a spelling
 * of) the message it reacts to. See `reader.ts`'s `foldReactions` for how
 * those become annotations rather than messages of their own.
 */
export interface RawMessageRow {
  rowid: string;
  guid: string;
  date_ns: string | null;
  text: string | null;
  attributed_body_hex: string | null;
  is_from_me: number;
  associated_message_type: number;
  associated_message_guid: string | null;
  chat_guid: string;
  chat_display_name: string | null;
  chat_identifier: string;
  sender_address: string | null;
}

/**
 * Every message (and every tapback row) in one window, across every chat,
 * oldest first.
 *
 * A message with no chat at all (`chat_message_join` never wrote one — seen in
 * the wild for a handful of system rows) is excluded by the `JOIN`: there is
 * no channel-day path for a message with no conversation to file it under, and
 * an `INNER JOIN` is what makes that a query-level guarantee rather than a
 * filter every caller has to remember.
 */
export function selectMessagesSql(window: MessageWindow): string {
  return [
    "SELECT",
    "  CAST(message.ROWID AS TEXT) AS rowid,",
    "  message.guid AS guid,",
    "  CAST(message.date AS TEXT) AS date_ns,",
    "  message.text AS text,",
    "  hex(message.attributedBody) AS attributed_body_hex,",
    "  COALESCE(message.is_from_me, 0) AS is_from_me,",
    "  COALESCE(message.associated_message_type, 0) AS associated_message_type,",
    "  message.associated_message_guid AS associated_message_guid,",
    "  chat.guid AS chat_guid,",
    "  chat.display_name AS chat_display_name,",
    "  chat.chat_identifier AS chat_identifier,",
    "  sender.id AS sender_address",
    "FROM message",
    "JOIN chat_message_join ON chat_message_join.message_id = message.ROWID",
    "JOIN chat ON chat.ROWID = chat_message_join.chat_id",
    "LEFT JOIN handle AS sender ON sender.ROWID = message.handle_id",
    `WHERE ${messageWindowSql(window)}`,
    "ORDER BY message.ROWID ASC;",
  ].join("\n");
}

/** One attachment, named by the GUID of the message it belongs to. Metadata only — never the bytes. */
export interface RawAttachmentRow {
  message_guid: string;
  filename: string | null;
  mime_type: string | null;
  total_bytes: string | null;
}

/**
 * Attachments for every message in one window.
 *
 * Joined through `message` (for the window and the GUID) rather than filtered
 * by a list of message ids built in JavaScript, for the reason the header
 * gives: nothing content-derived is spliced into SQL, and a fixed join costs
 * nothing a real Mac's attachment table would notice.
 */
export function selectAttachmentsSql(window: MessageWindow): string {
  return [
    "SELECT",
    "  message.guid AS message_guid,",
    "  attachment.filename AS filename,",
    "  attachment.mime_type AS mime_type,",
    "  CAST(attachment.total_bytes AS TEXT) AS total_bytes",
    "FROM message_attachment_join",
    "JOIN message ON message.ROWID = message_attachment_join.message_id",
    "JOIN attachment ON attachment.ROWID = message_attachment_join.attachment_id",
    `WHERE ${messageWindowSql(window)};`,
  ].join("\n");
}

/** One participant of one group (or one-on-one) chat. */
export interface RawParticipantRow {
  chat_guid: string;
  address: string;
}

/**
 * Every chat's participant list, unfiltered.
 *
 * `chat_handle_join` is sized by how many *conversations* a person has, not by
 * how many *messages* — reading it whole every sync is cheap on any real Mac,
 * and it is what keeps this query from ever needing a chat GUID spliced into
 * its `WHERE` clause.
 */
export function selectParticipantsSql(): string {
  return [
    "SELECT chat.guid AS chat_guid, handle.id AS address",
    "FROM chat_handle_join",
    "JOIN chat ON chat.ROWID = chat_handle_join.chat_id",
    "JOIN handle ON handle.ROWID = chat_handle_join.handle_id;",
  ].join("\n");
}

/** The highest `message.ROWID` this app has ever synced, for the next `{kind: "since"}` window. */
export function selectMaxRowIdSql(): string {
  return "SELECT CAST(COALESCE(MAX(ROWID), 0) AS TEXT) AS rowid FROM message;";
}
