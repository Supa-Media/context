/**
 * `POST /gateway/bots/mail` — `{ workspaceId, bot, area, note, from, type? }` → `{ ok, status }`, behind the gateway's
 * secret only (`gatewayRoute`), like `/gateway/rows/mirror`: the caller is the workspace object that just saved a new
 * line in an area's mail (`apps/mcp/src/workspaceStore/botMail.js`), with nobody signed in.
 *
 * What a caller holding only that secret can do here: make a bot that already has a webhook in that workspace hear
 * "mail arrived" for a path under its area's `mail/`, or "a routine is due" (`type: "routine"`) for a path under its
 * area's `routines/`, within the bot's hourly allowance. It reads nothing back: no
 * address, no key, no note. See `functions/botHooks.ts`.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { hashToken } from "../crypto";
import { mailJoinName } from "@context/shared/src/areaBots.cjs";

export async function gatewayBotMailHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const fields = { workspaceId: stringField(body, "workspaceId"), bot: stringField(body, "bot"), area: stringField(body, "area"), note: stringField(body, "note"), from: stringField(body, "from") };
  if (Object.values(fields).some((value) => value === null)) return json({ ok: false, status: 0 });
  const { workspaceId, bot, area, note, from } = fields as Record<keyof typeof fields, string>;
  // An area's routine that came due (`apps/mcp/src/workspaceStore/areaRoutines.js`): its note is the routine note.
  const type = stringField(body, "type") === "routine" ? "routine" : "mail";
  const cleared = await ctx.runMutation(internal.functions.botHooks.authorizeObjectMail, { workspaceId, bot, area, note, from, type });
  if (cleared === null) return json({ ok: false, status: 0 });
  const result = await ctx.runAction(internal.functions.botHooks.callBotHook, {
    workspaceId: cleared.workspaceId,
    bot,
    payload: { type, workspace: cleared.workspace, bot, from, area, note },
  });
  return json(result);
}

/**
 * `POST /gateway/bots/hook` — an agent setting, testing or listing a bot's webhook (`manage area`), behind both proofs:
 * the gateway's secret and the person's own access token, cleared as an editor of the workspace their grant names.
 * `{ action: "bind", bot, name }` → `{ ok, workspaceId, bot }`: the calling connection is that bot here, and the
 * check starts (`functions/botLogins.ts`). `{ action: "answered" }`: a bound login sent mail; its token alone clears it.
 * `{ action: "list" }` → `{ hooks }`; `{ action: "set", bot, address, header?, signingKey? }` → `{ host, headerEnds,
 * keyMade }`; `{ action: "test", bot }` → `{ ok, status }`. A refusal is `{ error }` in words a person can act on. No
 * answer ever carries an address, a header's value or a key.
 */
export async function gatewayBotHookHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return json({ error: "refused" });
  // A bound bot's login answered in mail (`apps/mcp/src/tools/notes/mail.js`): its own token is the proof, no role asked.
  if (stringField(body, "action") === "answered") {
    await ctx.runMutation(internal.functions.botLogins.botAnswered, { hashedAccessToken: await hashToken(accessToken), expectedWorkspaceId: expected });
    return json({ ok: true });
  }
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
  if (action === "bind") {
    // The bot's own connection says which bot it is here (`functions/botLogins.ts`); the gateway checked the card.
    const name = stringField(body, "name") ?? bot;
    return json(await ctx.runMutation(internal.functions.botLogins.bindBotLogin, { hashedAccessToken: await hashToken(accessToken), expectedWorkspaceId: expected, bot, name }));
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
  if (action === "ticket") {
    // A one-time ticket the bot spends from its shell with its header's value (`functions/botHookTickets.ts`).
    const address = stringField(body, "address");
    const headerName = stringField(body, "headerName");
    if (address === null || headerName === null || bot === "") return json({ error: "Pass the bot's name, its webhook address and the header's name." });
    const ticket = randomOpaqueToken(32);
    const refused = await ctx.runMutation(internal.functions.botHookTickets.mintBotHookTicket, {
      hashedTicket: await hashToken(ticket),
      hashedAccessToken: await hashToken(accessToken),
      workspaceId: cleared.workspaceId,
      userId: cleared.actorUserId,
      bot,
      address,
      headerName,
    });
    return json(refused ?? { ticket, minutes: 10 });
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
  return json({ error: "action is list, set, ticket, test or bind." });
}

/** The longest header value a ticket takes. */
const HEADER_VALUE_MAX = 4096;

/**
 * `POST /gateway/bots/hook-ticket` — `{ ticket, value }` → `{ host, headerEnds }`, behind the gateway's secret only:
 * the caller is the gateway's `PUT /api/bot-hook`, where a bot ran the command `manage area` gave it. The ticket is the
 * person's authority, spent once; the person it names is cleared again with the token that minted it, so a revoked
 * grant or a lost role spends nothing. The answer never carries the value.
 */
export async function gatewayBotHookTicketHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const ticket = stringField(body, "ticket");
  const value = stringField(body, "value")?.trim() ?? "";
  if (ticket === null || !/^[A-Za-z0-9_-]{16,256}$/.test(ticket)) return json({ error: "refused" });
  if (value === "" || value.length > HEADER_VALUE_MAX || /[\r\n]/.test(value)) return json({ error: "Send the header's value, on one line, as the body." });
  const spent = await ctx.runMutation(internal.functions.botHookTickets.spendBotHookTicket, { hashedTicket: await hashToken(ticket) });
  const refused = { error: "This command was already used or has expired. Ask manage area for a new one." };
  if (spent === null) return json(refused);
  const cleared = await ctx.runQuery(internal.functions.controlPlane.editorClearanceForGateway, {
    hashedAccessToken: spent.hashedAccessToken,
    expectedWorkspaceId: spent.workspaceId,
  });
  if (cleared === null || cleared.workspaceId !== spent.workspaceId || cleared.actorUserId !== spent.userId) return json(refused);
  try {
    const saved = await ctx.runAction(internal.functions.botHooks.setBotHookFor, {
      workspaceId: spent.workspaceId,
      userId: spent.userId,
      bot: spent.bot,
      address: spent.address,
      headerLine: `${spent.headerName}: ${value}`,
    });
    return json({ host: saved.host, headerEnds: saved.headerEnds });
  } catch (error) {
    const said = (error as { data?: { message?: unknown } })?.data?.message;
    return json({ error: typeof said === "string" ? said : "That webhook could not be saved." });
  }
}
