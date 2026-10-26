/**
 * The SQL the Messages backup runs against `chat.db`, and the rows it reads.
 *
 * The same rules as `core/imessage/schema.ts`, which this sits beside and
 * borrows from: every `BLOB` is hex-encoded and every 64-bit integer cast to
 * `TEXT` in the query, and **nothing a sender chose the bytes of is ever
 * spliced into SQL**. The only interpolated values are ROWID bounds and an
 * Apple-epoch instant, each checked as plain digits first, and column names
 * from `OPTIONAL_COLUMNS`, a fixed list matched against what the database
 * itself reports.
 *
 * Apple adds columns over macOS releases (`date_edited` and `date_retracted`
 * arrived with editing and unsending). Naming a column an older `chat.db`
 * does not have fails the whole query, so the backup asks which of the
 * optional ones exist (`selectMessageColumnsSql`) and reads only those.
 */

/** Columns read when the database has them. Never a value from anywhere else. */
export const OPTIONAL_COLUMNS = Object.freeze(["date_edited", "date_retracted", "thread_originator_guid", "service"] as const);
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

/** A page of `message` rows: a ROWID range, or every row edited or unsent after an instant. */
export type BackupWindow =
  | { kind: "range"; afterRowId: number; throughRowId: number }
  | { kind: "changed"; afterNs: string; limit: number };

function rowId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`not a valid ROWID: ${value}`);
  return value;
}

function digits(value: string): string {
  if (!/^\d{1,20}$/.test(value)) throw new TypeError(`not a digit string: ${JSON.stringify(value)}`);
  return value;
}

function has(columns: ReadonlySet<string>, name: OptionalColumn): boolean {
  return columns.has(name);
}

/**
 * The `WHERE` clause for one window. A `changed` window needs at least one of
 * the two change columns; without either there is nothing to ask, and the
 * caller is told so by `canReadChanges` before it ever builds one.
 */
function windowSql(window: BackupWindow, columns: ReadonlySet<string>): string {
  if (window.kind === "range") {
    return `message.ROWID > ${rowId(window.afterRowId)} AND message.ROWID <= ${rowId(window.throughRowId)}`;
  }
  const after = digits(window.afterNs);
  const parts: string[] = [];
  if (has(columns, "date_edited")) parts.push(`COALESCE(message.date_edited, 0) > ${after}`);
  if (has(columns, "date_retracted")) parts.push(`COALESCE(message.date_retracted, 0) > ${after}`);
  if (parts.length === 0) throw new TypeError("this chat.db records no edits or unsends");
  return `(${parts.join(" OR ")})`;
}

/** Whether this database can say which messages were edited or unsent. */
export function canReadChanges(columns: ReadonlySet<string>): boolean {
  return has(columns, "date_edited") || has(columns, "date_retracted");
}

/** Which columns `message` has. Read once per launch. */
export function selectMessageColumnsSql(): string {
  return "SELECT name FROM pragma_table_info('message');";
}

/** The columns this app knows about, out of whatever the database answered. */
export function knownColumns(rows: readonly unknown[]): Set<OptionalColumn> {
  const found = new Set<OptionalColumn>();
  for (const row of rows) {
    const name = (row as { name?: unknown })?.name;
    if (typeof name === "string" && (OPTIONAL_COLUMNS as readonly string[]).includes(name)) found.add(name as OptionalColumn);
  }
  return found;
}

export interface BackupMessageRow {
  rowid: string;
  guid: string;
  date_ns: string | null;
  text: string | null;
  attributed_body_hex: string | null;
  is_from_me: number;
  associated_message_type: number;
  associated_message_guid: string | null;
  chat_guid: string;
  sender_address: string | null;
  /** `null` when the column does not exist or the message was never edited. */
  date_edited_ns: string | null;
  date_retracted_ns: string | null;
  reply_to_guid: string | null;
  service: string | null;
}

/**
 * Every message and tapback row in one window, in ROWID order. A row with no
 * chat is left out by the `JOIN`, as `schema.ts` argues: there is no
 * conversation to file it in.
 */
export function selectBackupMessagesSql(window: BackupWindow, columns: ReadonlySet<string>): string {
  const optional = (name: OptionalColumn, select: string, alias: string) =>
    has(columns, name) ? `  ${select} AS ${alias},` : `  NULL AS ${alias},`;
  const order = window.kind === "changed"
    ? `ORDER BY MAX(${has(columns, "date_edited") ? "COALESCE(message.date_edited, 0)" : "0"}, ${has(columns, "date_retracted") ? "COALESCE(message.date_retracted, 0)" : "0"}) ASC LIMIT ${rowId(window.limit)};`
    : "ORDER BY message.ROWID ASC;";
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
    optional("date_edited", "CAST(NULLIF(message.date_edited, 0) AS TEXT)", "date_edited_ns"),
    optional("date_retracted", "CAST(NULLIF(message.date_retracted, 0) AS TEXT)", "date_retracted_ns"),
    optional("thread_originator_guid", "message.thread_originator_guid", "reply_to_guid"),
    optional("service", "message.service", "service"),
    "  chat.guid AS chat_guid,",
    "  sender.id AS sender_address",
    "FROM message",
    "JOIN chat_message_join ON chat_message_join.message_id = message.ROWID",
    "JOIN chat ON chat.ROWID = chat_message_join.chat_id",
    "LEFT JOIN handle AS sender ON sender.ROWID = message.handle_id",
    `WHERE ${windowSql(window, columns)}`,
    order,
  ].join("\n");
}

export interface BackupAttachmentRow {
  message_guid: string;
  filename: string | null;
  transfer_name: string | null;
  mime_type: string | null;
  total_bytes: string | null;
}

/** Attachment metadata for every message in a ROWID range. Names and sizes only, never the bytes. */
export function selectBackupAttachmentsSql(afterRowId: number, throughRowId: number): string {
  return [
    "SELECT",
    "  message.guid AS message_guid,",
    "  attachment.filename AS filename,",
    "  attachment.transfer_name AS transfer_name,",
    "  attachment.mime_type AS mime_type,",
    "  CAST(attachment.total_bytes AS TEXT) AS total_bytes",
    "FROM message_attachment_join",
    "JOIN message ON message.ROWID = message_attachment_join.message_id",
    "JOIN attachment ON attachment.ROWID = message_attachment_join.attachment_id",
    `WHERE message.ROWID > ${rowId(afterRowId)} AND message.ROWID <= ${rowId(throughRowId)};`,
  ].join("\n");
}

export interface BackupChatRow {
  chat_guid: string;
  display_name: string | null;
  chat_identifier: string | null;
  service_name: string | null;
}

/** Every conversation. Sized by conversations, not messages, so it is read whole. */
export function selectChatsSql(): string {
  return "SELECT guid AS chat_guid, display_name, chat_identifier, service_name FROM chat;";
}

/** The highest ROWID, and how many rows there are. */
export function selectMessageTotalsSql(): string {
  return "SELECT CAST(COALESCE(MAX(ROWID), 0) AS TEXT) AS max_rowid, CAST(COUNT(*) AS TEXT) AS rows FROM message;";
}

/** How many rows sit at or above `fromRowId`: the part of the history the backup has reached. */
export function selectRowsFromSql(fromRowId: number): string {
  return `SELECT CAST(COUNT(*) AS TEXT) AS rows FROM message WHERE ROWID >= ${rowId(fromRowId)};`;
}

/**
 * The account this Mac's Messages is signed into, as the most common
 * `account_login` across its chats (`E:` an email, `P:` a phone number).
 * Shown to the person, masked, so a shared Mac is caught before anything
 * leaves; never sent anywhere.
 */
export function selectAccountSql(): string {
  return "SELECT account_login AS login FROM chat WHERE account_login IS NOT NULL AND account_login != '' GROUP BY account_login ORDER BY COUNT(*) DESC LIMIT 1;";
}

/**
 * Attachment metadata for a set of rows, for edits and unsends: those rows
 * are scattered across the history, and a range spanning them could be all
 * of it. Each id is checked as a ROWID before it is written into the list.
 */
export function selectAttachmentsForRowsSql(rowIds: readonly number[]): string {
  const ids = [...new Set(rowIds.map(rowId))].sort((a, b) => a - b);
  if (ids.length === 0) throw new TypeError("no rows to read files for");
  return [
    "SELECT",
    "  message.guid AS message_guid,",
    "  attachment.filename AS filename,",
    "  attachment.transfer_name AS transfer_name,",
    "  attachment.mime_type AS mime_type,",
    "  CAST(attachment.total_bytes AS TEXT) AS total_bytes",
    "FROM message_attachment_join",
    "JOIN message ON message.ROWID = message_attachment_join.message_id",
    "JOIN attachment ON attachment.ROWID = message_attachment_join.attachment_id",
    `WHERE message.ROWID IN (${ids.join(", ")});`,
  ].join("\n");
}
