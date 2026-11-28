/**
 * Note mail over HTTP (`functions/noteMail.ts`, `docs/decisions/note-mail.md`):
 *
 *  - `POST /gateway/mail/join` `{ accessToken, workspaceId, path, name, jobId?, machineId? }` →
 *    `{ mailbox }`, `{ error: "name_taken" | "refused" }`, or `{ error: "own_name", name }` when a job part joins
 *    under a name that is not its job's own.
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
  if (answer.ok) return json({ mailbox: answer.mailbox });
  return json(answer.error === "own_name" ? { error: answer.error, name: answer.name } : { error: answer.error });
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

/**
 * `POST /gateway/mail/tex` `{ accessToken, workspaceId, path, mailboxId }` → `{ owner: personalWorkspaceId | null }`:
 * a line was sent to a person's own Tex on this note, so their Tex in mail is woken (`functions/noteMail.ts`
 * `askTexMail`). The token is the sender's; `null` answers every refusal alike.
 */
export async function gatewayMailTexHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  const path = stringField(body, "path");
  const mailboxId = stringField(body, "mailboxId");
  if (accessToken === null || workspaceId === null || path === null || mailboxId === null) return json({ owner: null });
  const forHandle = stringField(body, "forHandle");
  const asked = await ctx.runMutation(internal.functions.noteMail.askTexMail, {
    hashedAccessToken: await hashToken(accessToken),
    workspaceId,
    path,
    mailboxId,
    ...(forHandle !== null ? { forHandle } : {}),
  });
  return json({ owner: asked?.owner ?? null });
}

/**
 * `POST /gateway/mail/tex-seat` `{ accessToken, workspaceId, path }` → `{ mailboxId | null }`: an agent with no seat
 * sent mail on this note, so its person's Tex gets a mailbox there and hears the reply (`functions/noteMail.ts`
 * `texSeatMailbox`). The token is the agent's own.
 */
export async function gatewayMailTexSeatHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  const path = stringField(body, "path");
  if (accessToken === null || workspaceId === null || path === null) return json({ mailboxId: null });
  const mailboxId = await ctx.runMutation(internal.functions.noteMail.texSeatMailbox, {
    hashedAccessToken: await hashToken(accessToken),
    workspaceId,
    path,
    mailboxId: `mb_${randomOpaqueToken(8)}`,
  });
  return json({ mailboxId });
}

/**
 * `POST /agent-texts/mail-runs/due` (the texting Worker's secret) `{ owner }` → `{ runs: [{ runId, accessToken,
 * workspaceId, path, mailboxId }] }`: the Tex-in-mail runs waiting for this personal workspace's person, each with a
 * texting session of theirs (`functions/texMail.ts`). The plaintext tokens are made here and returned once; only their
 * hashes reach the database.
 */
export async function agentTexMailDueHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const owner = stringField(body, "owner");
  if (owner === null || owner.length > 64) return json({ runs: [] });
  const plaintext: string[] = [];
  const tokens: Array<{ hashedAccessToken: string; hashedRefreshToken: string }> = [];
  const runIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const accessToken = `cat_${randomOpaqueToken(32)}`;
    plaintext.push(accessToken);
    tokens.push({ hashedAccessToken: await hashToken(accessToken), hashedRefreshToken: await hashToken(`unissued_${randomOpaqueToken(32)}`) });
    runIds.push(`texmail_${randomOpaqueToken(16)}`);
  }
  const claimed = await ctx.runMutation(internal.functions.texMail.claimTexMailRuns, { ownerWorkspaceId: owner, runIds, tokens });
  return json({ runs: claimed.map(({ token, ...run }) => ({ ...run, accessToken: plaintext[token]! })) });
}
