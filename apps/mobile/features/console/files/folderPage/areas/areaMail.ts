/**
 * An area's mail: a `mail/` folder in the area with one note per sender, a
 * person or an AI (the owner, 2026-11-25: "mail is a folder and then per
 * person it's one note, or per, not just per person, per AI"), so a busy
 * area's conversations never pile into its `about.md`. Each note keeps its
 * conversation as note mail (`@context/shared/src/mail.cjs`): append-only,
 * signed, and the bot answers in the same note. Pure — no React, no storage.
 */

import { isNotePath, withoutTextExtension } from "@context/shared/src/fileKinds.cjs";
import { appendMail, parseMail, type MailEvent } from "@context/shared/src/mail.cjs";
import type { ListNote } from "../../listBlock/model";
import { cardSlug } from "./seat";

/** The folder in an area that holds its mail. */
export const MAIL_FOLDER = "mail";

export function mailFolder(area: string): string {
  return `${area}/${MAIL_FOLDER}`;
}

/** The area's mail notes, directly in its `mail/` folder, in name order. */
export function mailNotesOf(area: string, notes: readonly ListNote[]): string[] {
  const prefix = `${mailFolder(area)}/`;
  return notes
    .map((note) => note.path)
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && isNotePath(path))
    .sort((a, b) => a.localeCompare(b));
}

/** The note `sender` writes to the area in: `@seyi` → `<area>/mail/seyi.md`. */
export function senderNote(area: string, sender: string): string {
  return `${mailFolder(area)}/${cardSlug(sender)}.md`;
}

/** Who a mail note is with, from its name: `mail/seyi.md` → "seyi". */
export function senderOf(path: string): string {
  return withoutTextExtension(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * A new conversation's whole text: a title naming the two sides and the first
 * message, written as note mail so the bot reads and answers it like any.
 * An error when the message cannot be mail (empty, too long, no sender).
 */
export function firstMailNote(holder: string, sender: string, text: string, at?: string): { text: string } | { error: string } {
  const head = `# Mail with ${holder.trim()}\n`;
  const result = appendMail(head, { from: sender, kind: "mail", to: "everyone", text, ...(at === undefined ? {} : { at }) });
  if (result.error !== undefined) return { error: result.error };
  let out = head;
  for (const change of [...result.changes].sort((a, b) => b.from - a.from)) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return { text: out };
}

export interface Thread {
  readonly count: number;
  readonly last: MailEvent | null;
  /** When a bot's Refresh was last sent in this note (`refreshAsk`, or the older name-and-logo ask), or null. */
  readonly refreshedAt?: string | null;
  /** Context's newest setup check in this note (`apps/mcp/src/tools/notes/botBind.js`) and who wrote after it, or null. */
  readonly check?: { readonly at: string; readonly after: readonly string[] } | null;
}

/** How Context's setup check starts (`botBind.js` `CHECK_TEXT`). */
const CHECK_START = "Setup check from Context";
/** How long a bot has to answer its setup check before its card says it is not answering. */
export const BOT_CHECK_MS = 5 * 60 * 1000;

/**
 * Whether a bot answers, read from its check mail (Dev, 2026-11-26: "marks the connection healthy only when the reply
 * comes from the bot's own identity within a few minutes"). Only its bound login signs as the bot (`tools/notes/
 * mail.js` refuses anyone else that name), so a line under one of the bot's `names` after the check is the bot answering.
 */
export function checkHealth(check: Thread["check"], names: readonly string[], now: number = Date.now()): "answering" | "checking" | "not answering" | null {
  if (check === null || check === undefined) return null;
  if (check.after.some((from) => names.includes(from))) return "answering";
  return now - Date.parse(check.at) < BOT_CHECK_MS ? "checking" : "not answering";
}

/** How a Refresh mail starts, now and before the relay setup (2026-11-26), so the panel can say when it last went. */
const REFRESH_STARTS = ["Please refresh your Context setup", "Please check your card here"];

/** How many messages a mail note holds, its newest, and when Refresh last went in it. */
export function threadOf(text: string): Thread {
  const messages = parseMail(text).events.filter((event) => event.kind === "mail");
  const refreshes = messages.filter((event) => REFRESH_STARTS.some((start) => (event.text ?? "").startsWith(start)));
  let checkIndex = -1;
  messages.forEach((event, index) => {
    if (event.from === "context" && (event.text ?? "").startsWith(CHECK_START)) checkIndex = index;
  });
  const check = checkIndex === -1 ? null : { at: messages[checkIndex]!.at, after: messages.slice(checkIndex + 1).map((event) => event.from) };
  return { count: messages.length, last: messages[messages.length - 1] ?? null, refreshedAt: refreshes[refreshes.length - 1]?.at ?? null, check };
}
