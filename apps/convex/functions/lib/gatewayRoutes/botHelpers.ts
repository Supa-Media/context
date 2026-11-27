/**
 * A bot's helpers, behind the gateway's secret (`functions/botHelpers.ts`;
 * `docs/decisions/app-and-console/bot-helpers.md`):
 *
 *   - `POST /gateway/bots/helper/start` — `{ accessToken, expectedWorkspaceId, helperId, bot, botName, name, mail, note,
 *     hours? }` → `{ ticket, expiresAt, ticketExpiresAt }`: the bot's own token, cleared as an editor of the workspace,
 *     asks for one helper. The ticket comes back once, and only its hash is kept.
 *   - `POST /gateway/bots/helper/claim` — `{ ticket }` → `{ accessToken, helperId, expiresAt }`: the gateway's
 *     `POST /api/bot-helper`, where the bot ran the command `start_helper` gave it. The token is minted here, returned
 *     once, and written by the bot's shell straight into the helper's config; it never passes through a model.
 *   - `POST /gateway/bots/helper/end` — `{ accessToken, helperId }` → `{ ended, bot, mail, note }`: the helper's own
 *     token, or its bot's.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { hashToken } from "../crypto";

const HELPER_TOKEN_PREFIX = "cxh_";
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

async function startHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const fields = { helperId: stringField(body, "helperId"), bot: stringField(body, "bot"), botName: stringField(body, "botName"), name: stringField(body, "name"), mail: stringField(body, "mail"), note: stringField(body, "note") };
  if (accessToken === null || expected === null || Object.values(fields).some((value) => value === null)) return json({ error: "refused" });
  const hashedParentToken = await hashToken(accessToken);
  const cleared = await ctx.runQuery(internal.functions.controlPlane.editorClearanceForGateway, { hashedAccessToken: hashedParentToken, expectedWorkspaceId: expected });
  if (cleared === null) return json({ error: "Only an owner's or an editor's bot starts helpers here." });
  const hours = typeof body.hours === "number" && Number.isFinite(body.hours) ? body.hours : undefined;
  const ticket = randomOpaqueToken(32);
  const started = await ctx.runMutation(internal.functions.botHelpers.startBotHelper, {
    hashedParentToken,
    hashedTicket: await hashToken(ticket),
    workspaceId: cleared.workspaceId,
    ...(fields as Record<keyof typeof fields, string>),
    ...(hours === undefined ? {} : { ms: hours * 60 * 60 * 1000 }),
  });
  if ("error" in started) return json(started);
  return json({ ticket, expiresAt: started.expiresAt, ticketExpiresAt: started.ticketExpiresAt });
}

async function claimHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const ticket = stringField(body, "ticket");
  if (ticket === null || !TICKET_PATTERN.test(ticket)) return json({ error: "refused" });
  const accessToken = `${HELPER_TOKEN_PREFIX}${randomOpaqueToken(32)}`;
  const claimed = await ctx.runMutation(internal.functions.botHelpers.claimBotHelper, { hashedTicket: await hashToken(ticket), hashedAccessToken: await hashToken(accessToken) });
  if (claimed === null) return json({ error: "This command was already used or has expired. Ask start_helper for a new helper." });
  return json({ accessToken, helperId: claimed.helperId, expiresAt: claimed.expiresAt });
}

async function endHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const helperId = stringField(body, "helperId");
  if (accessToken === null || helperId === null) return json({ error: "refused" });
  const ended = await ctx.runMutation(internal.functions.botHelpers.endBotHelper, { helperId, hashedAccessToken: await hashToken(accessToken) });
  return json(ended === null ? { error: "No such helper, or only it and its bot can end it." } : { ended: true, ...ended });
}

/** The paths http.ts registers, each POST and each behind `gatewayRoute`. */
export const BOT_HELPER_GATEWAY_ROUTES: ReadonlyArray<readonly [string, (ctx: ActionCtx, body: Record<string, unknown>) => Promise<Response>]> = [
  ["/gateway/bots/helper/start", startHandler],
  ["/gateway/bots/helper/claim", claimHandler],
  ["/gateway/bots/helper/end", endHandler],
];
