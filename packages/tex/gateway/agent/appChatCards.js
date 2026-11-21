/**
 * The cards the Context app's chat shows for an ask (`agent/appChatRows.js`). An ask that holds one email is put to the
 * person as `askLine` writes it, a text wall; the app reads that wall back into its fields and draws a card, and an ask
 * that is not one email (a calendar change, a vault use, an email with a forward or attachment) is shown as its summary.
 *
 * Pure: no I/O. The caller looks up what the card needs and passes it in: the live approval record (or null), the chat
 * object's kept state for the ask (`app:card:<ask>`, `texChat/appChat.js`), and the ask's text as the ledger has it.
 * `parseAskEmail` is the reverse of `askLine` for the single-email form, so a test can prove the two agree
 * (`test/appChatCards.test.mjs`).
 */

import { EMAIL_TOOL } from "../../../../apps/mcp/src/tools/email.js";

/** A body or a detail is cut to this many characters on the card. */
export const CARD_TEXT_CAP = 24_000;
/** A subject, sender, recipient or summary is cut to this many characters on the card. */
export const CARD_FIELD_CAP = 500;
/** A send the chat object kept as `sending` counts as still sending for this long; after it, it is shown as `wait`. */
const SENDING_MS = 120_000;

/** `askLine`'s opening for one email: "Here's the email I'd send", or "... from @name's email" in a group. */
const HEAD = /^Here's the email I'd send(?: from @[^\s']+'s email)?:$/;
/** The yes paragraph `askLine` ends with: "Give it a 👍", or "@name, give it a 👍" when only that person can OK it. */
const YES = /^(?:Give it a 👍|@[^\s,]+, give it a 👍)/u;
/** The copy's lines that make an ask no card: a forwarded email, or attachments (`email.js` `emailCopy`). */
const NOT_A_CARD = ["(Below this goes the forwarded email", "(Attached:"];
/** The line `emailCopy` writes for a reply in the existing thread. */
const THREAD = "(A reply inside the existing email thread.)";

/**
 * Reads one held email back out of the ask line `askLine` writes for it.
 *
 * Returns `{ from, to, cc, subject, thread, body }`: `from` is null when the copy names no sender, `to` and `cc` are the
 * raw comma-joined strings (`cc` is "" when there is none), `thread` is true for a reply, and `body` is everything after
 * the blank line that ends the headers, less the yes paragraph. Returns null for anything else: a multi-email ask, an
 * ask with a forward or attachments (not editable as a card), or text that is not an ask line.
 *
 * @param {string} text the ask's text as the chat shows it
 * @returns {{ from: string | null, to: string, cc: string, subject: string, thread: boolean, body: string } | null}
 */
export function parseAskEmail(text) {
  if (typeof text !== "string" || NOT_A_CARD.some((mark) => text.includes(mark))) return null;
  const lines = text.split("\n");
  if (!HEAD.test(lines[0] ?? "") || lines[1] !== "") return null;
  const headers = { from: null, to: null, cc: "", subject: null, thread: false };
  // The email's headers run to the first blank line after them; only the lines `emailCopy` writes are headers.
  let index = 2;
  for (; index < lines.length && lines[index] !== ""; index++) {
    const line = lines[index];
    if (line === THREAD) headers.thread = true;
    else if (line.startsWith("From: ")) headers.from = line.slice("From: ".length);
    else if (line.startsWith("To: ")) headers.to = line.slice("To: ".length);
    else if (line.startsWith("Cc: ")) headers.cc = line.slice("Cc: ".length);
    else if (line.startsWith("Subject: ")) headers.subject = line.slice("Subject: ".length);
    else return null;
  }
  if (index >= lines.length || headers.to === null || headers.subject === null) return null;
  // The yes paragraph is the last line, after one blank line; the body is what lies between.
  const last = lines.length - 1;
  const yesAt = last > index && YES.test(lines[last]) ? last : -1;
  const body = lines.slice(index + 1, yesAt === -1 ? lines.length : yesAt - 1).join("\n");
  return { from: headers.from, to: headers.to, cc: headers.cc, subject: headers.subject, thread: headers.thread, body };
}

/**
 * The card an ask shows in the app chat, or null when there is nothing to show (no live record and no ask text).
 *
 * `record` is the live pending approval (`id, tool, args, summary, detail, kind, chat_key`), or null once it has
 * settled. `kept` is what the chat object kept for this ask (`{ state, at, body? }`), or undefined. `askText` is the ask
 * line's text, used when there is no live record. `done` is true when the record was settled approved within the last
 * hour, so an ask that just went out reads as sent rather than gone.
 *
 * Card shapes:
 *   `{ kind: "email", state, from, to, cc, subject, thread, body, editable, at? }`
 *   `{ kind: "other", state, summary, detail, always?, at? }` (`always` only for a vault use)
 * `state` is one of `held`, `sending`, `wait` (live), `sent`, `gone` (settled without a send that the chat kept).
 * `editable` is true only for a live email the person may change: waiting or held, with no chat to answer in.
 *
 * @param {{ record?: object | null, kept?: { state: string, at: number, body?: string } | undefined, askText?: string, now?: number, done?: boolean }} input
 * @returns {object | null}
 */
export function cardOf({ record = null, kept, askText, now = Date.now(), done = false } = {}) {
  const stamp = typeof kept?.at === "number" ? { at: kept.at } : {};
  if (record) return liveCard(record, kept, now, stamp);
  if (typeof askText !== "string") return null;
  const state = kept?.state === "sending" || kept?.state === "sent" || done ? "sent" : "gone";
  const parsed = parseAskEmail(askText);
  if (parsed === null) return { kind: "other", state, summary: askText.split("\n")[0].slice(0, 200), detail: null, ...stamp };
  return {
    kind: "email",
    state,
    from: cut(parsed.from, CARD_FIELD_CAP),
    to: cut(parsed.to, CARD_FIELD_CAP),
    cc: cut(parsed.cc, CARD_FIELD_CAP),
    subject: cut(parsed.subject, CARD_FIELD_CAP),
    thread: parsed.thread,
    body: cut(typeof kept?.body === "string" ? kept.body : parsed.body, CARD_TEXT_CAP),
    editable: false,
    ...stamp,
  };
}

/** The card for an ask whose approval is still live (`cardOf`). */
function liveCard(record, kept, now, stamp) {
  const state = kept?.state === "held" ? "held" : kept?.state === "sending" && now - kept.at < SENDING_MS ? "sending" : "wait";
  const args = record.args && typeof record.args === "object" ? record.args : {};
  const forwarded = Boolean(args.forward) || (Array.isArray(args.attach) ? args.attach.length > 0 : Boolean(args.attach));
  if (record.tool !== EMAIL_TOOL || forwarded) {
    const other = { kind: "other", state, summary: cut(String(record.summary ?? ""), CARD_FIELD_CAP), detail: cut(record.detail ?? null, CARD_TEXT_CAP), ...stamp };
    return record.kind === "vault_use" ? { ...other, always: true } : other;
  }
  return {
    kind: "email",
    state,
    from: cut(firstOf(args.from) ?? fromLine(record.detail), CARD_FIELD_CAP),
    to: cut(listOf(args.to), CARD_FIELD_CAP),
    cc: cut(listOf(args.cc), CARD_FIELD_CAP),
    subject: cut(typeof args.subject === "string" ? args.subject : "", CARD_FIELD_CAP),
    thread: Boolean(args.replyTo),
    body: cut(typeof args.body === "string" ? args.body : "", CARD_TEXT_CAP),
    editable: (state === "wait" || state === "held") && (record.chat_key ?? null) === null,
    ...stamp,
  };
}

/** A string cut to `max` characters; anything else passed through unchanged. */
function cut(value, max) {
  return typeof value === "string" ? value.slice(0, max) : value;
}

/** A list of addresses as the raw comma-joined string; a string as it is. */
function listOf(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(", ");
  return typeof value === "string" ? value : "";
}

/** The first of a string or a list of strings; null when there is none. */
function firstOf(value) {
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

/** The sender named on a copy's first line ("From: ..."), or null. */
function fromLine(detail) {
  if (typeof detail !== "string") return null;
  const first = detail.split("\n", 1)[0];
  return first.startsWith("From: ") ? first.slice("From: ".length) : null;
}
