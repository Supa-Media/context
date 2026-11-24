/**
 * Running the group (Dev, 2026-11-23: "running the group"; design `@supa projects/tex-imessage-line/photon-sending-design.md`).
 * Tex names an iMessage group, sets its photo, or adds someone, the way it starts a poll: lines of its answer, one each,
 * "(name the chat) Lisbon trip", "(set the chat photo)" and "(add to the chat) +1 555 010 0199". Anyone in the chat may
 * ask (Dev, 2026-11-23: "Anyone in the chat can ask"). Those lines are taken out of the words and done on the line
 * (`GroupLine.runGroup`); the rest of the answer is texted as usual.
 *
 * Checked in code, never by the model, on the asker's own message:
 * - a person is added only by a number or email the asker's own text holds, so nobody is added on Tex's guess;
 * - the photo is a picture the asker sent with this text, already on the line (its attachment's guid).
 * What is refused is said in the chat, so an answer that says "done" is never left standing alone.
 *
 * Pure: no fetch, no storage.
 */

import type { InboundAttachment } from "./inbound";

export type GroupAction = { kind: "name"; name: string } | { kind: "photo"; attachment: string } | { kind: "add"; address: string };
export type GroupRefusal = "add_not_in_their_words" | "add_not_an_address" | "photo_none" | "name_empty";

/** As the bridge allows (`validate.mjs` `group/name`). */
const MAX_NAME = 100;
const LINE = /^[ \t]*\((name the chat|set the chat photo|add to the chat)\)[ \t]*(.*)$/gim;
const EMAIL = /^[^\s@()<>]+@[^\s@()<>]+\.[A-Za-z]{2,}$/;
/** A number as people type one: digits, spaces, dots, dashes, brackets, a leading +. */
const PHONE_IN_WORDS = /\+?\d[\d\s().-]{6,}\d/g;
/** Where a picture on Photon's line is served (`photon.ts` `attachmentUrl`). */
const PHOTON_ATTACHMENT = /\/photon\/attachment\/([^/?#]+)$/;

/** A number or email as the bridge takes it: E.164, or the email in lower case; null for anything else. */
export function addressOf(said: string): string | null {
  const text = said.trim();
  if (EMAIL.test(text)) return text.toLowerCase();
  if (!/^\+?[\d\s().-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Every number and email the asker's own words hold, as `addressOf` writes them. */
function addressesIn(words: string): Set<string> {
  const found = new Set<string>();
  for (const match of words.matchAll(PHONE_IN_WORDS)) {
    const address = addressOf(match[0]);
    if (address !== null) found.add(address);
  }
  for (const token of words.split(/[\s,;<>()]+/)) {
    const address = EMAIL.test(token) ? token.toLowerCase() : null;
    if (address !== null) found.add(address);
  }
  return found;
}

/** The guid of the last picture the asker sent with this text on Photon's line; null when there is none. */
function photoOf(attachments: readonly InboundAttachment[] | undefined): string | null {
  for (const attachment of [...(attachments ?? [])].reverse()) {
    if (!attachment.mimeType.startsWith("image/")) continue;
    let path: string;
    try {
      path = new URL(attachment.url).pathname;
    } catch {
      continue;
    }
    const match = PHOTON_ATTACHMENT.exec(path);
    if (match !== null) return decodeURIComponent(match[1]!);
  }
  return null;
}

/**
 * Tex's text without its "running the group" lines, what each asks for that may be done, and what was refused.
 * `asked` is the message Tex is answering: its words and its pictures.
 */
export function groupRunOf(text: string, asked: { text: string; attachments?: readonly InboundAttachment[] }): { text: string; actions: GroupAction[]; refused: GroupRefusal[] } {
  const actions: GroupAction[] = [];
  const refused: GroupRefusal[] = [];
  let theirs: Set<string> | null = null;
  const rest = text.replace(LINE, (_line, what: string, value: string) => {
    const kind = what.toLowerCase();
    if (kind === "name the chat") {
      const name = value.trim().replace(/^["“']|["”']$/g, "").trim();
      if (name === "") refused.push("name_empty");
      else if (!actions.some((action) => action.kind === "name")) actions.push({ kind: "name", name: name.slice(0, MAX_NAME) });
    } else if (kind === "set the chat photo") {
      const attachment = photoOf(asked.attachments);
      if (attachment === null) refused.push("photo_none");
      else if (!actions.some((action) => action.kind === "photo")) actions.push({ kind: "photo", attachment });
    } else {
      const address = addressOf(value);
      theirs ??= addressesIn(asked.text);
      if (address === null) refused.push("add_not_an_address");
      else if (!theirs.has(address)) refused.push("add_not_in_their_words");
      else if (!actions.some((action) => action.kind === "add" && action.address === address)) actions.push({ kind: "add", address });
    }
    return "";
  });
  if (actions.length === 0 && refused.length === 0) return { text, actions, refused };
  return { text: rest.replace(/\n{3,}/g, "\n\n").trim(), actions, refused };
}

/** A text with its "running the group" lines taken out, for a line that cannot do them and a path with no asker. */
export function withoutGroupRun(text: string): string {
  const rest = text.replace(LINE, "");
  return rest === text ? text : rest.replace(/\n{3,}/g, "\n\n").trim();
}
