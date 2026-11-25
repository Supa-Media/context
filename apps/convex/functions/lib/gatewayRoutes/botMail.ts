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
import { hashToken } from "../crypto";
import { mailJoinName } from "@context/shared/src/areaBots.cjs";

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

/**
 * `POST /gateway/bots/hook` — an agent setting, testing or listing a bot's webhook (`manage area`), behind both proofs:
 * the gateway's secret and the person's own access token, cleared as an editor of the workspace their grant names.
 * `{ action: "list" }` → `{ hooks }`; `{ action: "set", bot, address, header?, signingKey? }` → `{ host, headerEnds,
 * keyMade }`; `{ action: "test", bot }` → `{ ok, status }`. A refusal is `{ error }` in words a person can act on. No
 * answer ever carries an address, a header's value or a key.
 */
export async function gatewayBotHookHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return json({ error: "refused" });
  const cleared = await ctx.runQuery(internal.functions.controlPlane.editorClearanceForGateway, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
  });
  if (cleared === null) return json({ error: "Only an owner or editor of this workspace can change its bots." });
  const action = stringField(body, "action");
  const bot = stringField(body, "bot") ?? "";
  if (action === "list") {
    return json({ hooks: await ctx.runQuery(internal.functions.botHooks.botHookListFor, { workspaceId: cleared.workspaceId, userId: cleared.actorUserId }) });
  }
  if (action === "test") {
    const name = mailJoinName(bot);
    const allowed = await ctx
      .runMutation(internal.functions.botHooks.authorizeBotCall, { workspaceId: cleared.workspaceId, userId: cleared.actorUserId, bot: name, kind: "test" })
      .catch(() => null);
    if (allowed === null) return json({ error: `${bot} has no webhook here, or you've sent too many calls this hour.` });
    return json(
      await ctx.runAction(internal.functions.botHooks.callBotHook, {
        workspaceId: cleared.workspaceId,
        bot: name,
        actorUserId: cleared.actorUserId,
        payload: { type: "test", workspace: allowed.workspace, bot: name, from: allowed.from },
      }),
    );
  }
  if (action === "set") {
    const address = stringField(body, "address");
    if (address === null || bot === "") return json({ error: "Pass the bot's name and its webhook address." });
    const header = stringField(body, "header");
    const signingKey = stringField(body, "signingKey");
    try {
      return json(
        await ctx.runAction(internal.functions.botHooks.setBotHookFor, {
          workspaceId: cleared.workspaceId,
          userId: cleared.actorUserId,
          bot,
          address,
          ...(header === null ? {} : { headerLine: header }),
          ...(signingKey === null ? {} : { signingKey }),
        }),
      );
    } catch (error) {
      const said = (error as { data?: { message?: unknown } })?.data?.message;
      return json({ error: typeof said === "string" ? said : "That webhook could not be saved." });
    }
  }
  return json({ error: "action is list, set or test." });
}
