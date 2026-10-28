/**
 * The agent Worker's routes for how Tex talks (`functions/texStyle.ts`, Dev2,
 * 2026-10-28), behind the Worker's secret like every `/agent-texts/*` route.
 * A style is checked here, at the trust boundary, against its closed sets
 * (`readTexStyle`): anything else is refused whole.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { groupKeyOf } from "../../textGroups";
import { badRequest, json, stringField } from "../gatewayAuth";
import { readTexStyle } from "../texStyle";

/** Longest Sendblue or WhatsApp group id taken, as the engagement route. */
const MAX_CHAT = 200;

/** `POST /agent-texts/style` `{ phone, style }` → `{ ok: true, style }` merged, or `{ ok: false }` for an unlinked phone. */
export async function agentTextsStyleHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const phone = stringField(body, "phone");
  const patch = readTexStyle(body.style);
  if (phone === null || patch === null) return badRequest();
  const style = await ctx.runMutation(internal.functions.texStyle.setTextsStyle, { phone, patch });
  return json(style === null ? { ok: false } : { ok: true, style });
}

/** `POST /agent-texts/group/style` `{ line, groupId, style, setBy }` → `{ ok: true, style }` merged, or `{ ok: false }` for a chat Tex has no row for. */
export async function agentTextsGroupStyleHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const line = stringField(body, "line");
  const groupId = stringField(body, "groupId");
  const setBy = stringField(body, "setBy");
  const patch = readTexStyle(body.style);
  if (line === null || groupId === null || groupId.length > MAX_CHAT || setBy === null || setBy.length > 320 || patch === null) return badRequest();
  const style = await ctx.runMutation(internal.functions.texStyle.setGroupTexStyle, { groupKey: await groupKeyOf(line, groupId), patch, setBy });
  return json(style === null ? { ok: false } : { ok: true, style });
}
