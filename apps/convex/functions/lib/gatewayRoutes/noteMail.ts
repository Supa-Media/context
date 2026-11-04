/**
 * Note mail over HTTP (`functions/noteMail.ts`, `docs/decisions/note-mail.md`):
 *
 *  - `POST /gateway/mail/join` `{ accessToken, workspaceId, path, name, jobId?, machineId? }` →
 *    `{ mailbox }` or `{ error: "name_taken" | "refused" }`.
 *  - `POST /gateway/mail/get` `{ accessToken, mailboxId }` → `{ mailbox | null }`.
 *  - `POST /gateway/mail/read` `{ accessToken, mailboxId, readThrough }` → `{ ok }`.
 *  - `POST /gateway/mail/jobs` `{ accessToken, workspaceId, path }` →
 *    `{ mailboxes: [{ mailboxId, name, jobId | machineId and machineWorkspaceId, own }] }`.
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
  // Optional: the Tex background job whose turn is joining. Absent is fine; present but not a string is refused.
  const jobId = body.jobId === undefined ? undefined : stringField(body, "jobId");
  // Optional: the person's own machine whose session is joining (`device`), so mail is pushed to it.
  const machineId = body.machineId === undefined ? undefined : stringField(body, "machineId");
  if (accessToken === null || workspaceId === null || path === null || name === null || jobId === null || machineId === null) {
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
      ...(jobId !== undefined ? { jobId } : {}),
      ...(machineId !== undefined ? { machineId } : {}),
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

/** The mailboxes on a note that Tex background jobs joined (`functions/noteMail.ts` `jobMailboxes`). */
export async function gatewayMailJobsHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  const path = stringField(body, "path");
  if (accessToken === null || workspaceId === null || path === null) return json({ mailboxes: [] });
  const mailboxes = await ctx.runQuery(internal.functions.noteMail.jobMailboxes, {
    hashedAccessToken: await hashToken(accessToken),
    workspaceId,
    path,
  });
  return json({ mailboxes });
}
