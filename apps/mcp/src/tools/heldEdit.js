/**
 * Editing a held email's body before the person's yes.
 *
 * The in-app Tex card shows the copy of an email Tex held for a yes, and the
 * person may change its body there before they press Send. This rewrites
 * only the body: who the email goes to, from whom, its subject and its place
 * in a thread stay as they were asked, and so do the ask's yes, its expiry
 * and its actor. The copy the person reads is built again from the new
 * arguments, so what they read is what their yes releases. Asks that are not
 * Tex's own texted email (a group chat's, a forward, one with attachments, a
 * vault's) are not editable here.
 */

import { askedByText, callKey, listPending } from "./approvals.js";
import { EMAIL_TOOL, emailCopy, readEmail } from "./email.js";
import { TEXTED_COPY_CAP } from "./emailGate.js";

const FROM_LINE = "From: ";

/** The sender the copy the person was shown names, when it names one. */
function shownFrom(detail) {
  const first = String(detail ?? "").split("\n", 1)[0];
  return first.startsWith(FROM_LINE) ? first.slice(FROM_LINE.length) : undefined;
}

/** Line endings as `\n`, and no whitespace at either end: the form a body is kept in. */
function normalise(body) {
  return String(body ?? "").replace(/\r\n/g, "\n").trim();
}

/** Whether the ask is one a person may change the body of: Tex's own, a plain email. */
function editable(record) {
  if (record.tool !== EMAIL_TOOL || record.args?.forward !== undefined || record.args?.attach !== undefined) return false;
  if (Object.hasOwn(record, "chat_key") && record.chat_key !== null) return false;
  if (record.kind !== undefined && record.kind !== null) return false;
  return askedByText(record);
}

/**
 * Rewrite the body of one held email this person may still approve.
 *
 * Resolves `{ ok: true, record, changed }`, where `record` is the ask as it
 * now stands and `changed` is false when the body was already that (nothing
 * is written). Otherwise `{ ok: false, why }`: `not_found` (no live ask with
 * this id for this person), `not_editable` (not Tex's plain email), `empty`,
 * `too_long` (the copy would outgrow one text), `invalid` (the email would
 * not be sent as written), or `conflict` (the ask changed while this read it).
 */
export async function reviseHeldEmail(store, id, { userId, body, now = Date.now() }) {
  const outcome = await revise(store, id, { userId, body, now });
  // The outcome only: never the body, never an address.
  console.log(JSON.stringify({ event: "held_email_edit", outcome: outcome.ok ? (outcome.changed ? "edited" : "unchanged") : outcome.why }));
  return outcome;
}

async function revise(store, id, { userId, body, now }) {
  const found = (await listPending(store, { userId, now })).find(({ record }) => record.id === id);
  if (!found) return { ok: false, why: "not_found" };
  const { key, etag, record } = found;
  if (!editable(record)) return { ok: false, why: "not_editable" };

  const text = normalise(body);
  if (text === "") return { ok: false, why: "empty" };
  if (text === normalise(record.args?.body)) return { ok: true, record, changed: false };

  const args = { ...record.args, body: text };
  const read = readEmail(args);
  if (read.error) return { ok: false, why: "invalid" };
  const email = read.email;
  // An address the copy showed but the arguments do not carry stays shown, as the copy was built.
  const from = email.from ?? shownFrom(record.detail);
  const detail = emailCopy({ ...email, from }, null, []);
  if (detail.length > TEXTED_COPY_CAP) return { ok: false, why: "too_long" };

  const next = { ...record, args, key: callKey(EMAIL_TOOL, args), detail, edited_at: now };
  // Written only if the ask is still the version read: a yes or another edit that landed first is not overwritten.
  const written = await store.put(key, JSON.stringify(next), { onlyIf: { etagMatches: etag } });
  if (!written) return { ok: false, why: "conflict" };
  return { ok: true, record: next, changed: true };
}
