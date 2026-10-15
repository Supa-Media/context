/**
 * Note mail over HTTP (`functions/noteMail.ts`, `docs/decisions/note-mail.md`):
 *
 *  - `POST /gateway/mail/join` `{ accessToken, workspaceId, path, name }` →
 *    `{ mailbox }` or `{ error: "name_taken" | "refused" }`.
 *  - `POST /gateway/mail/get` `{ accessToken, mailboxId }` → `{ mailbox | null }`.
 *  - `POST /gateway/mail/read` `{ accessToken, mailboxId, readThrough }` → `{ ok }`.
 *
 * The access token is the second proof, as for the session: each answer is
 * about the grant that token belongs to and nothing else. No mail text
 * crosses in either direction.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, randomOpaqueToken, stringField } from "../gatewayAuth";

export async function gatewayMailJoinHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  const path = stringField(body, "path");
  const name = stringField(body, "name");
  if (accessToken === null || workspaceId === null || path === null || name === null) {
    return json({ error: "refused" });
  }
  let answer;
  try {
    answer = await ctx.runMutation(internal.functions.noteMail.joinMailbox, {
      hashedAccessToken: await hashToken(accessToken),
      workspaceId,
      path,
      name,
      mailboxId: `mb_${randomOpaqueToken(8)}`,
    });
  } catch {
    return json({ error: "refused" });
  }
  return answer.ok ? json({ mailbox: answer.mailbox }) : json({ error: answer.error });
}

export async function gatewayMailGetHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const mailboxId = stringField(body, "mailboxId");
  if (accessToken === null || mailboxId === null) return json({ mailbox: null });
  const mailbox = await ctx.runQuery(internal.functions.noteMail.getMailbox, {
    hashedAccessToken: await hashToken(accessToken),
    mailboxId,
  });
  return json({ mailbox });
}

export async function gatewayMailReadHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const mailboxId = stringField(body, "mailboxId");
  const readThrough = stringField(body, "readThrough");
  if (accessToken !== null && mailboxId !== null && readThrough !== null) {
    await ctx.runMutation(internal.functions.noteMail.markMailRead, {
      hashedAccessToken: await hashToken(accessToken),
      mailboxId,
      readThrough,
    });
  }
  return json({ ok: true });
}
