/**
 * `POST /gateway/email/send`: send one email as the person whose token this is,
 * through their own connected Gmail (`lib/personEmail.ts`).
 *
 * Body `{ accessToken, expectedWorkspaceId, email: { from?, to, cc?, subject, body }, check? }`.
 * Answers `{ ok: true, from }` (with `check`, nothing is sent) or
 * `{ ok: false, refused }`.
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
import { gmailRaw, readPersonEmail, recipientLimitKey, recipientsOf } from "../personEmail";

const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_DRAFTS_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";

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
  try {
    const raw = gmailRaw(email, claimed.from);
    const response = await fetch(draft ? GMAIL_DRAFTS_ENDPOINT : GMAIL_SEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${minted.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(draft ? { message: { raw } } : { raw }),
    });
    log({ outcome: response.ok ? (draft ? "drafted" : "sent") : "http_error", status: response.status, recipients: recipientHashes.length, draft });
    if (!response.ok) return json({ ok: false, refused: "unavailable" });
  } catch {
    log({ outcome: "transport_error", draft });
    return json({ ok: false, refused: "unavailable" });
  }
  return json({ ok: true, from: claimed.from });
}
