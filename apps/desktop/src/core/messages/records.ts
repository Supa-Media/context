/**
 * Rows out of `chat.db`, in; backup records, out.
 *
 * A pure function over parsed rows, as `core/imessage/reader.ts` is. It
 * borrows that reader's decoders (`attributedBody.ts`, `appleTime.ts`, the
 * tapback rules) and none of its rendering: a backup record is the message as
 * the database holds it, not a line in a note.
 *
 * Three things differ from the old import on purpose:
 *
 *  - **A tapback is its own record**, keyed by its own id and naming its
 *    target, rather than a line appended to another message's body. The
 *    reader had to drop a reaction whose target fell outside its window; a
 *    record needs nothing from the window, so none is lost.
 *  - **An unsent message is a record**, with no words, so the copy forgets
 *    what the sender took back. Every other deletion on the Mac leaves the
 *    backup alone (owner's pick, 2026-10-26): Messages' own "keep for 30
 *    days" setting deletes history, and following it would erase the backup.
 *  - **Nothing is dropped for being empty when it was edited or unsent**: the
 *    empty row is exactly the news.
 */

import { BACKUP_VERSION } from "@context/communications/backup";
import { appleEpochNsToIso } from "../imessage/appleTime.ts";
import { attributedBodyFromHex } from "../imessage/attributedBody.ts";
import { targetMessageGuid } from "../imessage/reader.ts";
import type { RawParticipantRow } from "../imessage/schema.ts";
import { fileIdOf } from "./files.ts";
import type { BackupAttachmentRow, BackupChatRow, BackupMessageRow } from "./queries.ts";

export interface MessageRecord {
  v: 1;
  kind: "message";
  id: string;
  chat: string;
  at: string;
  me: boolean;
  from?: string;
  text: string;
  service: string;
  edited?: string;
  unsent?: true;
  replyTo?: string;
  files?: Array<{ id?: string; name?: string; type?: string; bytes?: number }>;
}

export interface ReactionRecord {
  v: 1;
  kind: "reaction";
  id: string;
  chat: string;
  at: string;
  me: boolean;
  from?: string;
  target: string;
  reaction: string;
  removed?: true;
}

export interface ChatRecord {
  v: 1;
  kind: "chat";
  id: string;
  name?: string;
  members: string[];
  service: string;
}

export interface PersonRecord {
  v: 1;
  kind: "person";
  handle: string;
  name: string;
}

export type BackupRecord = MessageRecord | ReactionRecord | ChatRecord | PersonRecord;

/** `associated_message_type` 2000–2005 added a tapback, 3000–3005 took it back. */
const REACTION_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: "loved",
  1: "liked",
  2: "disliked",
  3: "laughed",
  4: "emphasized",
  5: "questioned",
});

/**
 * A tapback row, of either sign. Wider than the reader's `isReactionRow` on
 * purpose: newer macOS adds kinds past 2005 (an emoji of the sender's
 * choosing), and a row of those read as a message would file "Reacted 👍 to
 * …" as words somebody wrote.
 */
export function isTapback(type: number): boolean {
  return type >= 2000 && type < 4000;
}

function reactionOf(type: number): { reaction: string; removed: boolean } {
  const removed = type >= 3000 && type < 4000;
  const base = removed ? type - 3000 : type - 2000;
  return { reaction: REACTION_NAMES[base] ?? "reacted", removed };
}

function serviceOf(value: string | null): string {
  if (value === "iMessage" || value === "SMS" || value === "RCS") return value;
  return "other";
}

/** A file's name: the name it was sent with, else the last part of where Messages keeps it. Never the Mac's path. */
function fileName(row: BackupAttachmentRow): string | undefined {
  const sent = (row.transfer_name ?? "").trim();
  if (sent) return sent;
  const stored = (row.filename ?? "").split("/").pop()?.trim();
  return stored || undefined;
}

function fileSize(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Records for one window of rows. Order follows the rows; the gateway folds
 * by id, so order only matters between two records for the same message,
 * and those are never in one window.
 */
export function recordsFromRows(
  messages: readonly BackupMessageRow[],
  attachments: readonly BackupAttachmentRow[],
): Array<MessageRecord | ReactionRecord> {
  const filesByMessage = new Map<string, BackupAttachmentRow[]>();
  for (const row of attachments) {
    const list = filesByMessage.get(row.message_guid);
    if (list) list.push(row);
    else filesByMessage.set(row.message_guid, [row]);
  }

  const records: Array<MessageRecord | ReactionRecord> = [];
  for (const row of messages) {
    const at = appleEpochNsToIso(row.date_ns);
    if (at === null || !row.guid || !row.chat_guid) continue;
    const me = Number(row.is_from_me) === 1;
    const from = me || !row.sender_address ? {} : { from: row.sender_address };

    if (isTapback(Number(row.associated_message_type))) {
      const target = targetMessageGuid(row.associated_message_guid);
      if (target === null) continue;
      const { reaction, removed } = reactionOf(Number(row.associated_message_type));
      records.push({
        v: BACKUP_VERSION,
        kind: "reaction",
        id: row.guid,
        chat: row.chat_guid,
        at,
        me,
        ...from,
        target,
        reaction,
        ...(removed ? { removed: true as const } : {}),
      });
      continue;
    }

    const unsent = row.date_retracted_ns !== null;
    const edited = row.date_edited_ns !== null ? appleEpochNsToIso(row.date_edited_ns) : null;
    const plain = (row.text ?? "").trim();
    const text = unsent ? "" : plain || attributedBodyFromHex(row.attributed_body_hex) || "";
    const files = unsent
      ? []
      : (filesByMessage.get(row.guid) ?? []).map((file) => {
          const id = fileIdOf(file.attachment_guid);
          const name = fileName(file);
          const bytes = fileSize(file.total_bytes);
          return {
            ...(id !== undefined ? { id } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(file.mime_type ? { type: file.mime_type } : {}),
            ...(bytes !== undefined ? { bytes } : {}),
          };
        });
    // A row with no words, no files, and nothing changed about it is a system
    // row (a group renamed, someone added): not a message anybody wrote.
    if (!text && files.length === 0 && !unsent && edited === null) continue;

    records.push({
      v: BACKUP_VERSION,
      kind: "message",
      id: row.guid,
      chat: row.chat_guid,
      at,
      me,
      ...from,
      text,
      service: serviceOf(row.service),
      ...(edited !== null ? { edited } : {}),
      ...(unsent ? { unsent: true as const } : {}),
      ...(row.reply_to_guid ? { replyTo: row.reply_to_guid } : {}),
      ...(files.length > 0 ? { files } : {}),
    });
  }
  return records;
}

/** One record per conversation, with its members. */
export function chatRecords(chats: readonly BackupChatRow[], participants: readonly RawParticipantRow[]): ChatRecord[] {
  const members = new Map<string, Set<string>>();
  for (const row of participants) {
    if (!row.chat_guid || !row.address) continue;
    const set = members.get(row.chat_guid) ?? new Set<string>();
    set.add(row.address);
    members.set(row.chat_guid, set);
  }
  const records: ChatRecord[] = [];
  for (const chat of chats) {
    if (!chat.chat_guid) continue;
    const name = (chat.display_name ?? "").trim();
    records.push({
      v: BACKUP_VERSION,
      kind: "chat",
      id: chat.chat_guid,
      ...(name ? { name } : {}),
      members: [...(members.get(chat.chat_guid) ?? [])].sort(),
      service: serviceOf(chat.service_name),
    });
  }
  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
