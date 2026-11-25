/**
 * `POST /gateway/bots/mail` — `{ workspaceId, bot, area, note, from }` → `{ ok, status }`, behind the gateway's
 * secret only (`gatewayRoute`), like `/gateway/rows/mirror`: the caller is the workspace object that just saved a new
 * line in an area's mail (`apps/mcp/src/workspaceStore/botMail.js`), with nobody signed in.
 *
 * What a caller holding only that secret can do here: make a bot that already has a webhook in that workspace hear
 * "mail arrived" for a path under its area's `mail/`, within the bot's hourly allowance. It reads nothing back: no
 * address, no key, no note. See `functions/botHooks.ts`.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json, stringField } from "../gatewayAuth";

export async function gatewayBotMailHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const fields = { workspaceId: stringField(body, "workspaceId"), bot: stringField(body, "bot"), area: stringField(body, "area"), note: stringField(body, "note"), from: stringField(body, "from") };
  if (Object.values(fields).some((value) => value === null)) return json({ ok: false, status: 0 });
  const { workspaceId, bot, area, note, from } = fields as Record<keyof typeof fields, string>;
  const cleared = await ctx.runMutation(internal.functions.botHooks.authorizeObjectMail, { workspaceId, bot, area, note, from });
  if (cleared === null) return json({ ok: false, status: 0 });
  const result = await ctx.runAction(internal.functions.botHooks.callBotHook, {
    workspaceId: cleared.workspaceId,
    bot,
    payload: { type: "mail", workspace: cleared.workspace, bot, from, area, note },
  });
  return json(result);
}
