/**
 * The agent Worker's routes for how Tex talks (`functions/texStyle.ts`, Dev2,
 * 2026-11-01), behind the Worker's secret like every `/agent-texts/*` route.
 * A change is checked here, at the trust boundary (`readSettingsAsk`): a quick
 * pick by its id, an undo or a clear, and a progress updates level, nothing else.
 */

import { gatewayTexChatHomeHandler } from "./texChatHome";
import { gatewayTexPageHandler, gatewayTexPageSettingsHandler } from "./texPage";
import { gatewayTexCommandHandler as texCommandHandler } from "./texCommand";
import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { groupKeyOf } from "../../textGroups";
import { serviceOfGroupId } from "../../textGroupNames";
import { badRequest, json, stringField } from "../gatewayAuth";
import { QUICK_PICKS, TEX_UPDATES, type InstructionsChange, type TexUpdates } from "../texInstructions";

/** Longest Sendblue or WhatsApp group id taken, as the engagement route. */
const MAX_CHAT = 200;

type Ask = { change?: InstructionsChange; updates?: TexUpdates };

/** `{ pick }`, `{ undo: true }`, `{ clear: true }` and or `{ updates }` from the Worker; null for anything else. */
export function readSettingsAsk(body: Record<string, unknown>): Ask | null {
  const { pick, undo, clear, updates } = body;
  const ask: Ask = {};
  if (pick !== undefined) {
    if (typeof pick !== "string" || !QUICK_PICKS.some((entry) => entry.id === pick)) return null;
    ask.change = { pick };
  } else if (undo === true) ask.change = { undo: true };
  else if (clear === true) ask.change = { clear: true };
  if (updates !== undefined) {
    if (typeof updates !== "string" || !(TEX_UPDATES as readonly string[]).includes(updates)) return null;
    ask.updates = updates as TexUpdates;
  }
  return ask.change === undefined && ask.updates === undefined ? null : ask;
}

/** What a saved change answers: the settings now, or why not. */
const answer = (saved: Record<string, unknown> | null) => json(saved === null ? { ok: false } : "refused" in saved ? { ok: false, refused: saved.refused } : { ok: true, ...saved });

/** `POST /agent-texts/style` `{ phone, pick | undo | clear, updates? }` → `{ ok: true, instructions?, updates? }`, or `{ ok: false }` unlinked. */
export async function agentTextsStyleHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const phone = stringField(body, "phone");
  const ask = readSettingsAsk(body);
  if (phone === null || ask === null) return badRequest();
  return answer(await ctx.runMutation(internal.functions.texStyle.setTextsStyle, { phone, ...ask }));
}

/** `POST /agent-texts/group/style` `{ line, groupId, setBy, pick | undo | clear, updates? }` → as the 1:1 route, `{ ok: false }` for a chat Tex has no row for. */
export async function agentTextsGroupStyleHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const line = stringField(body, "line");
  const groupId = stringField(body, "groupId");
  const setBy = stringField(body, "setBy");
  const ask = readSettingsAsk(body);
  if (line === null || groupId === null || groupId.length > MAX_CHAT || setBy === null || setBy.length > 320 || ask === null) return badRequest();
  return answer(await ctx.runMutation(internal.functions.texStyle.setGroupTexStyle, { groupKey: await groupKeyOf(line, groupId), setBy, ...ask }));
}

/** `POST /gateway/tex/command`: the agent's chat commands, on the turn's own grant (`texCommand.ts`). */
export { gatewayTexCommandHandler } from "./texCommand";

/** Routes registered together in `http.ts`: the agent's chat commands, and the Tex page's two (`texPage.ts`). */
export const TEX_ROUTES = [
  ["/gateway/tex/command", texCommandHandler],
  ["/gateway/tex/page", gatewayTexPageHandler],
  ["/gateway/tex/page/settings", gatewayTexPageSettingsHandler],
  ["/gateway/tex/chat-home", gatewayTexChatHomeHandler],
] as const;

/** `POST /agent-texts/group/name` `{ line, groupId, name }` → `{ ok }`: the chat's name for its home in the app (`textGroupNames.ts`). */
export async function agentTextsGroupNameHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const line = stringField(body, "line");
  const groupId = stringField(body, "groupId");
  const name = typeof body.name === "string" ? body.name : undefined;
  if (line === null || groupId === null || groupId.length > MAX_CHAT || (body.name !== undefined && name === undefined) || (name?.length ?? 0) > 2_000) return badRequest();
  return json(
    await ctx.runMutation(internal.functions.textGroupNames.setChatName, { groupKey: await groupKeyOf(line, groupId), name, service: serviceOfGroupId(groupId) }),
  );
}

/** The texting Worker's group settings routes, registered together in `http.ts`. */
export const AGENT_GROUP_ROUTES = [
  ["/agent-texts/group/style", agentTextsGroupStyleHandler],
  ["/agent-texts/group/name", agentTextsGroupNameHandler],
] as const;
