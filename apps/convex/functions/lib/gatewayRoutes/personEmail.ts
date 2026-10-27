/**
 * `POST /gateway/email/send`: send one email as the person whose token this is,
 * through their own connected Gmail (`lib/personEmail.ts`).
 *
 * Body `{ accessToken, expectedWorkspaceId, email: { from?, to, cc?, subject, body, replyTo? }, check? }`.
 * `replyTo` is the Gmail id of a message in the `from` mailbox; the email is
 * sent inside that message's thread (In-Reply-To, References, threadId).
 * Without it, a subject starting "Re:" joins the newest thread in that
 * mailbox with the same subject and one of its recipients
 * (`lib/personEmailThread.ts`), or goes as a new email.
 * `forward` is the Gmail id of a message in the `from` mailbox: it goes below
 * the person's words with all of its attachments (`lib/personEmailForward.ts`),
 * sent through Gmail's upload endpoint, which takes a message that size.
 * Answers `{ ok: true, from }` (with `check`, nothing is sent) or
 * `{ ok: false, refused }`. An email with the AI's own files also answers
 * `attached`, each file as Gmail holds it once taken (`personEmailCheck.ts`).
 *
 * The gateway calls this only for an email the person said yes to, word for
 * word (`apps/mcp/src/tools/emailGate.js`). What is decided here is what the
 * gateway must not be trusted with alone: the sender is one of the token's
 * person's own Gmail connections that granted sending, and the limits hold
 * whatever the gateway does. The email itself is never stored or logged;
 * Google's error body can quote the request, so only a status is.
 *
 * `POST /gateway/email/draft` takes the same body and saves the email as a
 * draft in the person's Gmail instead (`gatewayPersonEmailDraftHandler`). It
 * reaches nobody, so the gateway does not hold it for a yes; the connection
 * must have granted `gmail.compose`, and the draft limits apply.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import { gmailRaw, headerText, readPersonEmail, recipientLimitKey, recipientsOf, replyHeadersOf, type PersonEmail, type ReplyThread } from "../personEmail";
import { getReplyHeaders } from "../../../../mcp/src/communications/gmailSync.js";
import { timeoutFetch } from "../filesFns/forwardSyncSupport";
import { findReplyThread } from "../personEmailThread";
import { attachedInGmail } from "../personEmailCheck";
import { forwardBody, forwardHeaders, forwardMime, newBoundary, readForwarded } from "../personEmailForward";

const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_DRAFTS_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
const GMAIL_SEND_UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const GMAIL_DRAFTS_UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media";

function log(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: "person_email", ...fields }));
}

export function gatewayPersonEmailHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  return personEmail(ctx, body, false);
}

export function gatewayPersonEmailDraftHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  return personEmail(ctx, body, true);
}

async function personEmail(ctx: ActionCtx, body: Record<string, unknown>, draft: boolean): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const email = readPersonEmail(body.email);
  const check = body.check === true;
  if (accessToken === null || expected === null) return json({ ok: false, refused: "not_allowed" });
  if (email === null) return json({ ok: false, refused: "invalid" });

  const mailboxes = [...new Set(recipientsOf(email).map(recipientLimitKey))];
  const recipientHashes = await Promise.all(mailboxes.map((mailbox) => hashToken(mailbox)));
  const claimed = await ctx.runMutation(internal.functions.personEmail.claimPersonEmail, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
    recipientHashes,
    from: email.from,
    spend: !check,
    draft,
  });
  if (!claimed.ok) {
    log({ outcome: "refused", reason: claimed.refused, check, draft });
    return json({ ok: false, refused: claimed.refused });
  }
  if (check) return json({ ok: true, from: claimed.from });

  // Spent before it is sent: a send that fails after Google accepted it still
  // counted, which is the safe direction for a limit against spam.
  const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, {
    connectionId: claimed.connectionId,
  });
  if (minted === null) {
    log({ outcome: "no_token", draft });
    return json({ ok: false, refused: "unavailable" });
  }
  // A forward reads the message from the sending mailbox itself, so it can only ever pass on the person's own mail.
  if (email.forward !== null) return await sendForward(minted.accessToken, email, claimed.from, draft, recipientHashes.length);
  // A reply joins the thread of the message it answers, read from the sending
  // mailbox itself, so it can only ever answer the person's own mail.
  let thread: ReplyThread | null = null;
  if (email.replyTo !== null) {
    try {
      thread = replyHeadersOf(await getReplyHeaders({ fetchImpl: timeoutFetch, accessToken: minted.accessToken, id: email.replyTo }));
    } catch {
      thread = null;
    }
    if (thread === null) {
      log({ outcome: "reply_not_found", draft });
      return json({ ok: false, refused: "reply_not_found" });
    }
  } else {
    // "Re:" with no thread named joins the one it answers, if the mailbox has it.
    thread = await findReplyThread(timeoutFetch, minted.accessToken, email);
    if (thread !== null) log({ outcome: "thread_found", draft });
  }
  if (email.files.length > 0) return await sendWithFiles(minted.accessToken, email, claimed.from, thread, draft, recipientHashes.length);
  try {
    const raw = gmailRaw(email, claimed.from, thread);
    const message = thread ? { raw, threadId: thread.threadId } : { raw };
    // Bounded, inside the gateway's own wait, so a send never completes
    // after the AI was told it failed and asks again (2026-10-20).
    const response = await timeoutFetch(draft ? GMAIL_DRAFTS_ENDPOINT : GMAIL_SEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${minted.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(draft ? { message } : message),
    });
    log({ outcome: response.ok ? (draft ? "drafted" : "sent") : "http_error", status: response.status, recipients: recipientHashes.length, draft });
    if (!response.ok) return json({ ok: false, refused: "unavailable" });
  } catch {
    log({ outcome: "transport_error", draft });
    return json({ ok: false, refused: "unavailable" });
  }
  return json({ ok: true, from: claimed.from });
}

/** A forward, attachments and all, sent (or saved as a draft) as one `message/rfc822` upload. */
async function sendForward(accessToken: string, email: PersonEmail, from: string, draft: boolean, recipients: number): Promise<Response> {
  const read = await readForwarded(timeoutFetch, accessToken, email.forward!);
  if (!read.ok) {
    log({ outcome: read.refused, draft, forward: true });
    return json({ ok: false, refused: read.refused });
  }
  const mime = forwardMime(
    forwardHeaders(email, from, headerText(email.subject)),
    forwardBody(email.body, read.forwarded),
    // Files the person's AI downloaded go after the forwarded email's own.
    [...read.forwarded.files, ...email.files],
    newBoundary(),
  );
  try {
    const response = await timeoutFetch(draft ? GMAIL_DRAFTS_UPLOAD : GMAIL_SEND_UPLOAD, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "message/rfc822" },
      body: mime as BodyInit,
    });
    log({ outcome: response.ok ? (draft ? "drafted" : "sent") : "http_error", status: response.status, recipients, draft, forward: true, files: read.forwarded.files.length });
    if (!response.ok) return json({ ok: false, refused: "unavailable" });
  } catch {
    log({ outcome: "transport_error", draft, forward: true });
    return json({ ok: false, refused: "unavailable" });
  }
  return json({ ok: true, from });
}

/**
 * An email with files the person's AI downloaded (`lib/personEmail.ts` `files`),
 * as one `message/rfc822`. A reply goes inside its thread through the JSON
 * endpoint, which carries a thread id and a message up to Gmail's 5 MB there;
 * anything else goes through the upload endpoint, as a forward does.
 */
async function sendWithFiles(accessToken: string, email: PersonEmail, from: string, thread: ReplyThread | null, draft: boolean, recipients: number): Promise<Response> {
  const headers = [
    ...forwardHeaders(email, from, headerText(email.subject)),
    ...(thread ? [`In-Reply-To: ${thread.inReplyTo}`, `References: ${thread.references.join(" ")}`] : []),
  ];
  const mime = forwardMime(headers, email.body, email.files, newBoundary());
  let created: unknown = null;
  if (thread !== null && mime.length > THREADED_MIME_BYTES) {
    log({ outcome: "too_large", draft, files: email.files.length });
    return json({ ok: false, refused: "too_large" });
  }
  try {
    let response: Response;
    if (thread !== null) {
      const message = { raw: base64Url(mime), threadId: thread.threadId };
      response = await timeoutFetch(draft ? GMAIL_DRAFTS_ENDPOINT : GMAIL_SEND_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(draft ? { message } : message),
      });
    } else {
      response = await timeoutFetch(draft ? GMAIL_DRAFTS_UPLOAD : GMAIL_SEND_UPLOAD, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "message/rfc822" },
        body: mime as BodyInit,
      });
    }
    log({ outcome: response.ok ? (draft ? "drafted" : "sent") : "http_error", status: response.status, recipients, draft, files: email.files.length });
    if (!response.ok) return json({ ok: false, refused: "unavailable" });
    created = await response.json().catch(() => null);
  } catch {
    log({ outcome: "transport_error", draft, files: email.files.length });
    return json({ ok: false, refused: "unavailable" });
  }
  // What Gmail holds, read back, so the AI says "attached" from Gmail's answer (`personEmailCheck.ts`).
  const attached = await attachedInGmail(accessToken, created, draft);
  if (attached !== null && attached.length < email.files.length) log({ outcome: "attachments_missing", draft, files: email.files.length, held: attached.length });
  return json({ ok: true, from, ...(attached !== null ? { attached } : {}) });
}

/** Under the 5 MB Gmail's JSON send takes, once base64url has grown the message by a third. */
const THREADED_MIME_BYTES = 3_500_000;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
