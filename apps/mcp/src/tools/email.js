/**
 * `send_email` (`send · email`): one email, sent as the person through their
 * own connected Gmail (`docs/decisions/communications/sending-email.md`).
 *
 * This handler only ever runs for an email the person said yes to, word for
 * word: every call is held by the gate in `emailGate.js` first, and only the
 * approved replay reaches here. The control plane then picks the sender off
 * this connection's own token, holds the limits and sends it
 * (`apps/convex/functions/lib/gatewayRoutes/personEmail.ts`). Nothing of the
 * email is written anywhere by this side.
 *
 * `save_email_draft` (`send · email_draft`) saves the same email as a draft
 * in the person's Gmail instead. It reaches nobody until the person sends it
 * from Gmail themselves, so nothing holds it for a yes; the control plane
 * still picks the connection (one that granted `gmail.compose`) and holds the
 * draft limits.
 */

import { toolError, toolText } from "./results.js";
import { parseEmailId } from "./emailRead.js";
import { attachedFiles, readAttach } from "./emailAttach.js";

export const EMAIL_TOOL = "send_email";
export const EMAIL_DRAFT_TOOL = "save_email_draft";

/** Kept equal to `apps/convex/functions/lib/personEmail.ts`, which checks again. */
export const MAX_RECIPIENTS = 10;
export const MAX_SUBJECT = 200;
export const MAX_BODY = 20_000;

const ADDRESS = /^[A-Za-z0-9.!#$%&\x27*+/=?^_\x60{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const BODY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const SUBJECT_CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

function addresses(value, field) {
  if (value === undefined) return { list: [] };
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) return { error: `${field} is a list of email addresses.` };
  const out = [];
  for (const item of list) {
    const address = typeof item === "string" ? item.trim() : "";
    if (address.length > 254 || !ADDRESS.test(address)) {
      return { error: `${field} has something that is not one plain email address (like jo@example.com, no name, one per item).` };
    }
    out.push(address.toLowerCase());
  }
  return { list: out };
}

/*
  Words that say the email carries something on with it: "attached",
  "enclosed", "I'm passing it on", "here's the receipt", a "Fwd:" subject.
  On 2026-10-22 Tex saved the owner a draft to a colleague saying "Google sent
  that receipt only to my Public Worship inbox, so I'm passing it on to you",
  with nothing forwarded, and the owner found the draft with no receipt in it.
  An email can carry another only as a forward (`forward`), so such words
  without one are refused, for a draft as for a send, the way Gmail asks
  about a forgotten attachment. An ask for something ("can you send me the
  attachment?") is none of these.
*/
const PASSES_ON = [
  /\b(?:I(?:'ve| have)?|I'm|I am|we(?:'ve| have)?)\s+(?:just\s+)?(?:attach(?:ed|ing)|enclos(?:ed|ing)|forwarding)\b/i,
  /\b(?:please\s+)?(?:find|see)\s+(?:it\s+)?(?:attached|enclosed|below)\b/i,
  /\b(?:is|are|it's|they're)\s+(?:attached|enclosed)\b/i,
  /\battached\s+(?:is|are|here|below|to this)\b/i,
  /\b(?:receipts?|invoices?|pdfs?|files?|statements?|documents?|copy|copies)\s+(?:is\s+|are\s+)?(?:attached|enclosed)\b/i,
  /\bpassing\s+(?:it|this|that|them|these|those)\s+(?:on|along)\b/i,
  /\bhere(?:'s| is| are)\s+(?:the|a|your|her|his|their|that|my)\s+(?:\w+\s+){0,3}(?:receipts?|invoices?|pdfs?|files?|statements?|documents?|copy|copies|attachments?|confirmations?)\b/i,
  /\b(?:receipts?|invoices?|pdfs?|files?|statements?|documents?|attachments?|email)\s+(?:is\s+|are\s+)?below\b/i,
];
const FORWARD_SUBJECT = /^\s*(?:fwd?|fw)\s*:/i;

export const PASSES_ON_ERROR =
  "the email says it passes something on (attached, forwarded, here's the receipt), but nothing goes with it. " +
  "An email carries another only as a forward: find that email with search_email (by sender with from:, an amount, a date range, or fewer words) " +
  "and pass its id as forward, so it goes below your words with its attachments. A file on a website (an invoice, a statement) goes as attach: " +
  "download it with a browse download step and pass the download: id it gives. Don't ask the person to forward, find or download it. " +
  "Take the line out only if nothing is meant to go with this email.";

/** Whether an email's words say it carries something on with it. */
export function passesSomethingOn(subject, body) {
  if (FORWARD_SUBJECT.test(String(subject ?? ""))) return true;
  const said = String(body ?? "").replace(/[\u2018\u2019]/g, "'");
  return PASSES_ON.some((pattern) => pattern.test(said));
}

/**
 * The email a call asks for, `{ email }` with addresses lowercased, or
 * `{ error }` saying what to fix. Never repaired: what is sent is exactly what
 * the person was shown.
 */
export function readEmail(args) {
  const to = addresses(args?.to, "to");
  const from = addresses(args?.from, "from");
  const cc = addresses(args?.cc, "cc");
  for (const part of [from, to, cc]) if (part.error) return { error: part.error };
  if (from.list.length > 1) return { error: "from is one of the person's own connected Gmail addresses, or left out." };
  if (to.list.length === 0) return { error: "to needs at least one address." };
  const all = [...to.list, ...cc.list];
  if (all.length > MAX_RECIPIENTS) return { error: `One email goes to at most ${MAX_RECIPIENTS} addresses, to and cc together.` };
  if (new Set(all).size !== all.length) return { error: "An address is listed twice." };
  const subject = typeof args?.subject === "string" ? args.subject : "";
  const body = typeof args?.body === "string" ? args.body : "";
  if (subject.trim() === "" || subject.length > MAX_SUBJECT || SUBJECT_CONTROL.test(subject)) {
    return { error: `subject is one line of 1 to ${MAX_SUBJECT} characters.` };
  }
  if (body.trim() === "" || body.length > MAX_BODY || BODY_CONTROL.test(body)) {
    return { error: `body is the email's plain text, 1 to ${MAX_BODY.toLocaleString("en-US")} characters.` };
  }
  // A reply names the email it answers, as search_email gave it, and goes from that email's mailbox.
  let reply = null;
  if (args?.in_reply_to !== undefined) {
    reply = parseEmailId(typeof args.in_reply_to === "string" ? args.in_reply_to.trim() : "");
    if (reply === null) return { error: "in_reply_to is the email:<address>/<id> id search_email gave for the email this answers." };
    if (from.list.length === 1 && from.list[0] !== reply.address) {
      return { error: `A reply goes from the mailbox the email is in: leave from out, or make it ${reply.address}.` };
    }
  }
  // A forward names the email it passes on, the same way, and goes from that email's mailbox too.
  let forward = null;
  if (args?.forward !== undefined) {
    forward = parseEmailId(typeof args.forward === "string" ? args.forward.trim() : "");
    if (forward === null) return { error: "forward is the email:<address>/<id> id search_email gave for the email to pass on." };
    if (reply !== null) return { error: "An email either answers one (in_reply_to) or forwards one (forward), not both." };
    if (from.list.length === 1 && from.list[0] !== forward.address) {
      return { error: `A forward goes from the mailbox the email is in: leave from out, or make it ${forward.address}.` };
    }
  }
  // Files downloaded in the browser, by id (`emailAttach.js`).
  const attach = readAttach(args?.attach);
  if (attach.error) return { error: attach.error };
  if (forward === null && attach.list.length === 0 && passesSomethingOn(subject, body)) return { error: PASSES_ON_ERROR };
  const sender = reply ? reply.address : forward ? forward.address : from.list[0];
  return {
    email: {
      ...(sender ? { from: sender } : {}),
      to: to.list,
      cc: cc.list,
      subject,
      body,
      ...(reply ? { replyTo: reply.messageId } : {}),
      ...(forward ? { forward: forward.messageId } : {}),
      ...(attach.list.length > 0 ? { attach: attach.list } : {}),
    },
  };
}

/**
 * The email exactly as the person reads it before they say yes. A forward
 * also says what goes below their words: the forwarded email (`forwarded`,
 * read by `emailGate.js`) and each attachment by name.
 */
export function emailCopy(email, forwarded = null, attached = []) {
  return [
    ...(email.from ? [`From: ${email.from}`] : []),
    `To: ${email.to.join(", ")}`,
    ...(email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
    `Subject: ${email.subject}`,
    ...(email.replyTo ? ["(A reply inside the existing email thread.)"] : []),
    "",
    email.body,
    ...(email.forward ? ["", forwardedLine(forwarded)] : []),
    ...(attached.length > 0 ? ["", `(Attached: ${attached.map((name) => String(name).replace(/\s+/g, " ").trim().slice(0, 80)).join(", ")}.)`] : []),
  ].join("\n");
}

/**
 * The email as the control plane takes it: the `attach` ids read into the
 * files themselves (`emailAttach.js`), `{ email }` or `{ error }`.
 */
async function withFiles(store, email) {
  const { attach, ...plain } = email;
  if (!attach || attach.length === 0) return { email: plain };
  const read = await attachedFiles(store, attach);
  return read.files ? { email: { ...plain, files: read.files } } : { error: read.error };
}

function forwardedLine(forwarded) {
  const subject = String(forwarded?.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const sender = String(forwarded?.from ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const names = (Array.isArray(forwarded?.attachments) ? forwarded.attachments : [])
    .map((file) => String(file?.filename ?? "").replace(/\s+/g, " ").trim().slice(0, 80))
    .filter(Boolean);
  const files = names.length === 0 ? "it has no attachments" : `with ${names.length === 1 ? "its attachment" : "its attachments"} ${names.join(", ")}`;
  return `(Below this goes the forwarded email${sender ? ` from ${sender}` : ""}${subject ? `, "${subject}"` : ""}, ${files}.)`;
}

/** One line for the approvals list and the "Done, I …" reply (`agent/doneLine.js`). */
export function emailSummary(email) {
  const others = email.to.length + email.cc.length - 1;
  const who = others > 0 ? `${email.to[0]} and ${others} more` : email.to[0];
  return `send an email to ${who}, "${email.subject.slice(0, 120)}"`;
}

/** What each refusal from the control plane tells the model. */
export const REFUSED = {
  invalid: "Not sent: the email was not valid.",
  not_allowed: "Not sent: this connection cannot send email as the person.",
  no_sender:
    "Not sent: the person has no Gmail connected that Context may send from. Send them the link from manage connect_google (kind gmail) " +
    "in one line, and send the email once they say it's connected; never hand them the email to send themselves.",
  hourly_limit: "Not sent: the person has sent 20 emails through Context this hour. Try again later.",
  daily_limit: "Not sent: the person has sent 100 emails through Context today. Try again tomorrow.",
  recipient_limit: "Not sent: the person has already emailed one of these addresses 10 times today through Context.",
  not_configured: "Not sent: this Context deployment does not send email.",
  reply_not_found: "Not sent: Gmail no longer has the email this replies to, or it has no thread to reply in. Search for it again.",
  forward_not_found: "Not sent: Gmail no longer has the email to forward, or one of its attachments. Search for it again.",
  too_large: "Not sent: the email is too big to send (over 20 MB of attachments, or more than 20 files).",
  reconnect_required:
    "Not sent: the Gmail it would go from needs reconnecting, because Google stopped honouring its sign-in. Tell the person; they reconnect it with manage connect_google.",
  unavailable: "Not sent: Gmail did not take the email just now. Nothing was sent; it can be asked for again.",
};

export async function toolSendEmail(store, args) {
  const read = readEmail(args);
  if (read.error) return toolError(`Not sent: ${read.error}`);
  if (typeof store?.email?.send !== "function") return toolError(REFUSED.not_configured);
  const ready = await withFiles(store, read.email);
  if (ready.error) return toolError(`Not sent: ${ready.error}.`);
  let answer;
  try {
    answer = await store.email.send(ready.email);
  } catch {
    return toolError(REFUSED.unavailable);
  }
  if (answer?.ok === true) return toolText(`Sent from ${answer.from} to ${[...read.email.to, ...read.email.cc].join(", ")}.`);
  return toolError(REFUSED[answer?.refused] ?? REFUSED.unavailable);
}

/** What each refusal of a draft tells the model. */
export const DRAFT_REFUSED = {
  invalid: "Not saved: the draft was not valid.",
  not_allowed: "Not saved: this connection cannot save drafts in the person's Gmail.",
  no_sender:
    "Not saved: the person has no Gmail connected that Context may save drafts in. Give them the draft to copy instead.",
  hourly_limit: "Not saved: 30 drafts were saved through Context this hour. Give them this one to copy instead.",
  daily_limit: "Not saved: 200 drafts were saved through Context today. Give them this one to copy instead.",
  not_configured: "Not saved: this Context deployment does not save drafts.",
  reply_not_found: "Not saved: Gmail no longer has the email this replies to. Search for it again.",
  forward_not_found: "Not saved: Gmail no longer has the email to forward, or one of its attachments. Search for it again.",
  too_large: "Not saved: the email is too big (over 20 MB of attachments, or more than 20 files).",
  reconnect_required:
    "Not saved: that Gmail needs reconnecting, because Google stopped honouring its sign-in. Tell the person; they reconnect it with manage connect_google.",
  unavailable: "Not saved: Gmail did not take the draft just now. It can be tried again.",
};

export async function toolSaveEmailDraft(store, args) {
  const read = readEmail(args);
  if (read.error) return toolError(`Not saved: ${read.error}`);
  if (typeof store?.email?.draft !== "function") return toolError(DRAFT_REFUSED.not_configured);
  const ready = await withFiles(store, read.email);
  if (ready.error) return toolError(`Not saved: ${ready.error}.`);
  let answer;
  try {
    answer = await store.email.draft(ready.email);
  } catch {
    return toolError(DRAFT_REFUSED.unavailable);
  }
  if (answer?.ok === true) {
    return toolText(`Saved as a draft in ${answer.from}'s Gmail, to ${[...read.email.to, ...read.email.cc].join(", ")}. Nothing was sent; they send it from Gmail when they are ready.`);
  }
  return toolError(DRAFT_REFUSED[answer?.refused] ?? DRAFT_REFUSED.unavailable);
}
