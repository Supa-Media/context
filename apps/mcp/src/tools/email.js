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
  const sender = reply ? reply.address : from.list[0];
  return {
    email: {
      ...(sender ? { from: sender } : {}),
      to: to.list,
      cc: cc.list,
      subject,
      body,
      ...(reply ? { replyTo: reply.messageId } : {}),
    },
  };
}

/** The email exactly as the person reads it before they say yes. */
export function emailCopy(email) {
  return [
    ...(email.from ? [`From: ${email.from}`] : []),
    `To: ${email.to.join(", ")}`,
    ...(email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
    `Subject: ${email.subject}`,
    ...(email.replyTo ? ["(A reply inside the existing email thread.)"] : []),
    "",
    email.body,
  ].join("\n");
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
    "Not sent: the person has no Gmail connected that Context may send from. Context can't send email yet; save it as a draft with save_email_draft, or give them the draft to copy and send themselves.",
  hourly_limit: "Not sent: the person has sent 5 emails through Context this hour. Try again later.",
  daily_limit: "Not sent: the person has sent 20 emails through Context today. Try again tomorrow.",
  recipient_limit: "Not sent: the person has already emailed one of these addresses 3 times today through Context.",
  not_configured: "Not sent: this Context deployment does not send email.",
  reply_not_found: "Not sent: Gmail no longer has the email this replies to, or it has no thread to reply in. Search for it again.",
  unavailable: "Not sent: Gmail did not take the email just now. Nothing was sent; it can be asked for again.",
};

export async function toolSendEmail(store, args) {
  const read = readEmail(args);
  if (read.error) return toolError(`Not sent: ${read.error}`);
  if (typeof store?.email?.send !== "function") return toolError(REFUSED.not_configured);
  let answer;
  try {
    answer = await store.email.send(read.email);
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
  hourly_limit: "Not saved: 10 drafts were saved through Context this hour. Give them this one to copy instead.",
  daily_limit: "Not saved: 50 drafts were saved through Context today. Give them this one to copy instead.",
  not_configured: "Not saved: this Context deployment does not save drafts.",
  reply_not_found: "Not saved: Gmail no longer has the email this replies to. Search for it again.",
  unavailable: "Not saved: Gmail did not take the draft just now. It can be tried again.",
};

export async function toolSaveEmailDraft(store, args) {
  const read = readEmail(args);
  if (read.error) return toolError(`Not saved: ${read.error}`);
  if (typeof store?.email?.draft !== "function") return toolError(DRAFT_REFUSED.not_configured);
  let answer;
  try {
    answer = await store.email.draft(read.email);
  } catch {
    return toolError(DRAFT_REFUSED.unavailable);
  }
  if (answer?.ok === true) {
    return toolText(`Saved as a draft in ${answer.from}'s Gmail, to ${[...read.email.to, ...read.email.cc].join(", ")}. Nothing was sent; they send it from Gmail when they are ready.`);
  }
  return toolError(DRAFT_REFUSED[answer?.refused] ?? DRAFT_REFUSED.unavailable);
}
