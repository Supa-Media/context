/**
 * Read receipts on Agent Mail (Dev, 2026-11-26: "show read receipts whenever an agent reads a mail", "whenever a mail
 * is read"; boards approved the same day). Pure: no React.
 *
 * The workspace keeps, per note, each reader's last read (`apps/mcp/src/workspaceStore/mailReads.js`): a person by
 * their `@handle`, an AI client by the name it registered and whose it is. Here each reader's receipt is placed under
 * the newest message it had read by then, never one it wrote itself, so it moves down as it reads on. The reader's
 * own reads are never shown. Under the reader's own newest message, when it is the last word and nobody else has read
 * it yet, "Not read yet".
 */

import { splitApp } from "@context/shared/src/mail.cjs";
import { isMe, nameOf } from "./model";

/** One reader's last read of a note's mail, as `/files/mail` `{read}` answers it. */
export interface MailRead {
  readonly name: string | null;
  readonly by: "person" | "ai";
  readonly clientName: string | null;
  readonly at: string;
}

/** A message as the thread holds it: who wrote it, signed with which app, and when. */
export interface ReceiptMessage {
  readonly from: string;
  readonly app?: string | null;
  readonly at: string;
}

/** Who read, as the receipt names and draws them. */
export interface Reader {
  /** "Grok Bot", "@shyoh", "@seyi's Claude Code". */
  readonly label: string;
  /** The mail name its face is drawn by, and the app it signs with: a sender in this mail, else its own name. */
  readonly face: { readonly name: string; readonly app: string | null };
  readonly at: number;
}

/** Under one message: who had read it last, and when the newest of them did. */
export interface Receipt {
  readonly readers: readonly Reader[];
  readonly at: number;
}

export type Receipts = ReadonlyMap<number, Receipt | "unread">;

/** The sender in this mail an AI read was, by the app it signs with and whose it is; null when none matches. */
function senderOf(read: MailRead, messages: readonly ReceiptMessage[]): ReceiptMessage | null {
  if (read.by !== "ai" || read.clientName === null) return null;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!;
    const signed = splitApp(message.app ?? null);
    if (signed.app !== null && signed.app.toLowerCase() === read.clientName.toLowerCase() && (signed.owner === null || read.name === null || signed.owner === read.name)) return message;
  }
  return null;
}

/** How one read is named and drawn. */
export function readerOf(read: MailRead, messages: readonly ReceiptMessage[]): Reader {
  const at = Date.parse(read.at);
  if (read.by === "person") return { label: read.name ?? "Someone", face: { name: read.name ?? "@someone", app: null }, at };
  const sender = senderOf(read, messages);
  if (sender !== null) return { label: nameOf(sender.from), face: { name: sender.from, app: sender.app ?? null }, at };
  const client = read.clientName ?? "An agent";
  const signed = read.name !== null ? `${client} · ${read.name}` : client;
  return { label: read.name !== null ? `${read.name}'s ${client}` : client, face: { name: client.toLowerCase().replace(/[^a-z0-9]+/g, "-"), app: signed }, at };
}

/** Each message's receipt, by its index in `messages` (oldest first). */
export function receiptsFor(messages: readonly ReceiptMessage[], reads: readonly MailRead[], me: string | undefined): Receipts {
  const out = new Map<number, Receipt | "unread">();
  const times = messages.map((message) => Date.parse(message.at));
  let newestOther = -Infinity;
  for (const read of reads) {
    if (read.by === "person" && read.name !== null && isMe(read.name, me)) continue;
    const reader = readerOf(read, messages);
    if (!Number.isFinite(reader.at)) continue;
    const self = read.by === "ai" ? senderOf(read, messages)?.from ?? null : read.name;
    let under = -1;
    for (let at = messages.length - 1; at >= 0; at -= 1) {
      if (times[at]! <= reader.at && messages[at]!.from !== self) {
        under = at;
        break;
      }
    }
    if (under < 0) continue;
    newestOther = Math.max(newestOther, reader.at);
    const was = out.get(under);
    const readers = was !== undefined && was !== "unread" ? [...was.readers, reader] : [reader];
    out.set(under, { readers: readers.sort((a, b) => b.at - a.at), at: Math.max(reader.at, was !== undefined && was !== "unread" ? was.at : -Infinity) });
  }
  const last = messages.length - 1;
  if (last >= 0 && isMe(messages[last]!.from, me) && !(newestOther >= times[last]!) && !out.has(last)) out.set(last, "unread");
  return out;
}

/** "Read by Grok Bot", "Read by Claude and Codex", "Read by Claude, Codex and 2 others". */
export function readByWords(readers: readonly Reader[]): string {
  const names = readers.map((reader) => reader.label);
  if (names.length <= 1) return `Read by ${names.join("")}`;
  if (names.length === 2) return `Read by ${names[0]} and ${names[1]}`;
  if (names.length === 3) return `Read by ${names[0]}, ${names[1]} and ${names[2]}`;
  return `Read by ${names[0]}, ${names[1]} and ${names.length - 2} others`;
}
