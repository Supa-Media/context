/**
 * Rows out of `chat.db`, in — `CommunicationEvent`s, out.
 *
 * Everything here is a pure function over already-parsed `sqlite3 -json`
 * rows: nothing in this file spawns a process, reads a file, or knows what
 * `/usr/bin/sqlite3` is. `sqlite.ts` is the seam that produces the arrays this
 * module reads; `test/imessageReader.test.mjs` hand-builds them directly, and
 * `test/imessageSqlite.test.mjs` builds them by actually running the real
 * queries against a fixture database and feeding the result through here — so
 * the same function is proven twice, against two different sources of rows
 * that must agree.
 */

import type { CommunicationEvent } from "@context/communications/protocol";
import { appleEpochNsToIso } from "./appleTime.ts";
import { attributedBodyFromHex } from "./attributedBody.ts";
import type { RawAttachmentRow, RawMessageRow, RawParticipantRow } from "./schema.ts";

/**
 * The `account` every iMessage event is filed under.
 *
 * `chat.db` is one database per Mac holding every iMessage account signed
 * into Messages, merged — there is no per-account split the way a mailbox has
 * one address per connection (`docs/decisions/communications.md`'s asymmetry:
 * "a person has several mailboxes and one iMessage"). This constant is the
 * value `messageAnchor` and `threadKey` hash into their identifiers; it never
 * appears in a folder path, because `channelFolder("imessage", …)` refuses an
 * account argument for this channel outright.
 */
export const IMESSAGE_ACCOUNT = "imessage";

/** `2000`–`2005`: a tapback landed. `3000`–`3005`: a tapback was removed. Anything else: an ordinary message. */
const TAPBACK_ADDED_RANGE: readonly [number, number] = [2000, 2005];
const TAPBACK_REMOVED_RANGE: readonly [number, number] = [3000, 3005];

const TAPBACK_LABELS: Readonly<Record<number, string>> = Object.freeze({
  2000: "loved",
  2001: "liked",
  2002: "disliked",
  2003: "laughed at",
  2004: "emphasized",
  2005: "questioned",
});

function isInRange(value: number, [low, high]: readonly [number, number]): boolean {
  return value >= low && value <= high;
}

/** Is this row a tapback (of either sign) rather than an ordinary message? */
export function isReactionRow(row: Pick<RawMessageRow, "associated_message_type">): boolean {
  const type = row.associated_message_type;
  return isInRange(type, TAPBACK_ADDED_RANGE) || isInRange(type, TAPBACK_REMOVED_RANGE);
}

/**
 * The message GUID a tapback's `associated_message_guid` names.
 *
 * macOS prefixes the target GUID with a short scheme — `p:0/<guid>` for a
 * tapback on a message with attachments, `bp:<guid>` for one without — and
 * this strips whichever is present. An unrecognised or absent prefix is
 * treated as "the whole string is the guid", which is the safe reading: it
 * either matches a real message and resolves, or matches nothing and the
 * tapback is silently dropped, never misattached.
 */
export function targetMessageGuid(associatedGuid: string | null): string | null {
  if (typeof associatedGuid !== "string" || associatedGuid === "") return null;
  const slash = associatedGuid.indexOf("/");
  if (associatedGuid.startsWith("p:") && slash !== -1) return associatedGuid.slice(slash + 1);
  if (associatedGuid.startsWith("bp:")) return associatedGuid.slice(3);
  return associatedGuid;
}

/** A short label for who reacted and how, for the annotation line — never a message of its own. */
function tapbackLine(row: RawMessageRow, participantName: (address: string | null) => string): string {
  const label = TAPBACK_LABELS[row.associated_message_type] ?? "reacted to";
  const who = row.is_from_me ? "You" : participantName(row.sender_address);
  return `${who} ${label} this message.`;
}

/** The chat's display name, or a comma-joined list of everyone else in it, for the note's thread heading. */
function chatSubject(
  row: Pick<RawMessageRow, "chat_guid" | "chat_display_name" | "chat_identifier">,
  participantsByChat: ReadonlyMap<string, readonly string[]>,
): string {
  const displayName = (row.chat_display_name ?? "").trim();
  if (displayName) return displayName;
  const participants = participantsByChat.get(row.chat_guid) ?? [];
  if (participants.length > 0) return participants.join(", ");
  return row.chat_identifier || "";
}

/** Group every attachment by the message it belongs to. */
function attachmentsByMessage(rows: readonly RawAttachmentRow[]): Map<string, RawAttachmentRow[]> {
  const map = new Map<string, RawAttachmentRow[]>();
  for (const row of rows) {
    const list = map.get(row.message_guid);
    if (list) list.push(row);
    else map.set(row.message_guid, [row]);
  }
  return map;
}

/** Group every participant address by the chat it belongs to, excluding a device's own address when known. */
function participantsByChat(
  rows: readonly RawParticipantRow[],
  selfAddresses: ReadonlySet<string>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (selfAddresses.has(row.address)) continue;
    const list = map.get(row.chat_guid);
    if (list) list.push(row.address);
    else map.set(row.chat_guid, [row.address]);
  }
  return map;
}

/** A best-effort byte size, or `undefined` for a column that came back NULL or unparsable. */
function attachmentSize(totalBytes: string | null): number | undefined {
  if (totalBytes === null) return undefined;
  const parsed = Number(totalBytes);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : undefined;
}

export interface ReadChatDbOptions {
  /**
   * This device's own handles (phone numbers, email addresses signed into
   * iMessage), so a group's own owner is never listed as a "participant" of
   * their own conversation the way a stranger is. Best-effort: an address
   * this app was never told about still appears, which only ever makes a
   * group's synthesized subject one name longer.
   */
  selfAddresses?: readonly string[];
}

/**
 * Turn one window's raw rows into the `CommunicationEvent`s
 * `packages/communications` renders.
 *
 * Three shapes of row are folded into the result, differently:
 *
 *  - an **ordinary message** (`associated_message_type === 0`) with no
 *    readable text at all — `text` null, no attributed-body string recovered,
 *    no attachments — is dropped. It is very often a system row (a group name
 *    change, a participant added) that carries no content this product
 *    files, and keeping it would put an empty heading in somebody's note.
 *  - a **tapback added** (`2000`–`2005`) is never its own event: it is folded
 *    into the body of the message it targets as one appended line, so a
 *    reaction never becomes a heading of its own in the rendered note — see
 *    `docs/decisions/communications.md` on why a channel-day note's headings
 *    are exactly its messages.
 *  - a **tapback removed** (`3000`–`3005`) is dropped outright. This app
 *    processes each window once; representing "removed" would mean carrying
 *    state across syncs about which tapbacks are still standing, which is
 *    more machinery than an undo that changes nothing about what was actually
 *    said is worth in v1.
 *
 * A tapback whose target message is outside this same window (a reaction to
 * a message from a previous day, added later) is silently dropped rather than
 * attached to nothing — the window this function was called with is the only
 * place it can look, and reaching further would mean widening every window
 * to "the whole history" just in case a reaction landed elsewhere later.
 */
export function readChatDbWindow(
  messages: readonly RawMessageRow[],
  attachments: readonly RawAttachmentRow[],
  participants: readonly RawParticipantRow[],
  options: ReadChatDbOptions = {},
): CommunicationEvent[] {
  const selfAddresses = new Set(options.selfAddresses ?? []);
  const byChat = participantsByChat(participants, selfAddresses);
  const attachmentsByGuid = attachmentsByMessage(attachments);
  const participantName = (address: string | null): string => address ?? "someone";

  const bodies = new Map<string, string>();
  const events: CommunicationEvent[] = [];
  const eventByGuid = new Map<string, CommunicationEvent>();

  for (const row of messages) {
    if (isReactionRow(row)) continue; // handled in the second pass, below
    const text = (row.text ?? "").trim();
    const attributed = text ? null : attributedBodyFromHex(row.attributed_body_hex);
    const body = text || attributed || "";
    const attachmentRows = attachmentsByGuid.get(row.guid) ?? [];
    if (!body && attachmentRows.length === 0) continue; // no readable content: see the header

    const sentAt = appleEpochNsToIso(row.date_ns);
    if (sentAt === null) continue; // an unreadable timestamp cannot be filed under a day at all

    const from = row.is_from_me
      ? { name: "You" }
      : { address: row.sender_address ?? undefined };
    const to = row.is_from_me
      ? (byChat.get(row.chat_guid) ?? []).map((address) => ({ address }))
      : [];

    const event: CommunicationEvent = {
      channel: "imessage",
      account: IMESSAGE_ACCOUNT,
      messageId: row.guid,
      threadId: row.chat_guid,
      sentAt,
      subject: chatSubject(row, byChat),
      from,
      to,
      body,
      attachments: attachmentRows.map((attachment) => ({
        filename: attachment.filename ?? undefined,
        contentType: attachment.mime_type ?? undefined,
        size: attachmentSize(attachment.total_bytes),
      })),
    };
    events.push(event);
    bodies.set(row.guid, body);
    eventByGuid.set(row.guid, event);
  }

  // Second pass: fold every tapback into the body of the message it targets.
  // A second pass rather than one, because a reaction can precede or follow
  // the message it targets in ROWID order (a person can react to something
  // sent seconds ago, and `chat.db` does not guarantee reaction rows sort
  // after their target).
  for (const row of messages) {
    if (!isReactionRow(row) || isInRange(row.associated_message_type, TAPBACK_REMOVED_RANGE)) continue;
    const targetGuid = targetMessageGuid(row.associated_message_guid);
    if (targetGuid === null) continue;
    const target = eventByGuid.get(targetGuid);
    if (target === undefined) continue; // outside this window; see the header
    // A tapback may only annotate a message in **its own conversation**.
    //
    // `associated_message_guid` is a value the reacting device chose the bytes
    // of, and message GUIDs are unique across the whole database rather than
    // per chat — so without this line a row filed under one chat can append
    // "<their handle> loved this message." to the body of a message in a
    // *different* one. Somebody who has ever messaged this Mac knows the GUIDs
    // of the messages they sent, and that is enough to write a line naming
    // themselves into a conversation they were never part of, inside the
    // fence, presented as something that happened there. The check is cheap
    // and the real case never needs it: macOS files a tapback in the same chat
    // as the message it reacts to, always.
    if (target.threadId !== row.chat_guid) continue;
    const line = tapbackLine(row, participantName);
    const base = bodies.get(targetGuid) ?? "";
    const next = base ? `${base}\n\n${line}` : line;
    bodies.set(targetGuid, next);
    target.body = next;
  }

  return events;
}
