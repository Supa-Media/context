/**
 * An area's mail: a `mail/` folder in the area with one note per sender, a
 * person or an AI (the owner, 2026-11-25: "mail is a folder and then per
 * person it's one note, or per, not just per person, per AI"), so a busy
 * area's conversations never pile into its `about.md`. Each note keeps its
 * conversation as note mail (`@context/shared/src/mail.cjs`): append-only,
 * signed, and the bot answers in the same note. Pure — no React, no storage.
 */

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
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && path.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));
}

/** The note `sender` writes to the area in: `@seyi` → `<area>/mail/seyi.md`. */
export function senderNote(area: string, sender: string): string {
  return `${mailFolder(area)}/${cardSlug(sender)}.md`;
}

/** Who a mail note is with, from its name: `mail/seyi.md` → "seyi". */
export function senderOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
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
}

/** How many messages a mail note holds, and its newest. */
export function threadOf(text: string): Thread {
  const messages = parseMail(text).events.filter((event) => event.kind === "mail");
  return { count: messages.length, last: messages[messages.length - 1] ?? null };
}
