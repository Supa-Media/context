/**
 * Decide's cap and usage when the gateway asks Clef itself (Dev2's pick,
 * 2026-11-05: decide moves into the gateway, and its daily cap and usage rows
 * stay as they are, off each text's path). The texting Worker asks the gate
 * now and then, keeps its answer for a few minutes, and reports what was
 * decided after the answer is in. Behind `AGENT_WORKER_SECRET`, like the rest
 * of `/agent-texts/*`.
 *
 * Neither route returns a workspace id: the chat is named as decide names it
 * (`line` and `chat` for a group, `sender` for a 1:1), and resolved here each
 * time. Counts and codes only in the logs.
 */

import type { ActionCtx } from "../../../_generated/server";
import { badRequest, json, stringField } from "../gatewayAuth";
import { recordDecidedElsewhere } from "../jev/elsewhere";
import { STYLES, type Style } from "@context/shared/src/textDecide.cjs";
import { internal } from "../../../_generated/api";
import { workspaceFor, type DecideBody } from "./textDecide";

const MAX_CHAT = 200;
/** One report covers at most this many decisions: the Worker reports each, so anything bigger is not one. */
const MAX_REPORTED = 1_000;

/** Who the chat is, as decide names it; null when it does not hold together. */
function chatOf(body: Record<string, unknown>): Pick<DecideBody, "chat" | "style" | "line" | "sender"> | null {
  const chat = stringField(body, "chat");
  const style = body.style;
  const line = stringField(body, "line");
  const sender = stringField(body, "sender");
  if (chat === null || chat.length > MAX_CHAT) return null;
  if (typeof style !== "string" || !(STYLES as readonly string[]).includes(style)) return null;
  if (style === "direct" ? sender === null : line === null) return null;
  return { chat, style: style as Style, ...(line !== null ? { line } : {}), ...(sender !== null ? { sender } : {}) };
}

const count = (value: unknown, max = MAX_REPORTED): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null);

/** The gate route (`http.ts`) → `{ ok: true, remaining }`, or `{ ok: false, reason, cause }` as decide answers a refusal. */
export async function agentTextsDecideGateHandler(ctx: ActionCtx, raw: Record<string, unknown>): Promise<Response> {
  const chat = chatOf(raw);
  if (chat === null) return badRequest();
  const workspaceId = await workspaceFor(ctx, chat as DecideBody);
  if (workspaceId === null) return json({ ok: false, reason: "unavailable", cause: "no_group" });
  const gate = await ctx.runQuery(internal.functions.jev.gate, { feature: "textDecide", workspaceId });
  console.info(JSON.stringify({ event: "texts.decide_gate", style: chat.style, ...(gate.allowed ? { remaining: gate.remaining } : { cause: gate.reason }) }));
  if (gate.allowed) return json({ ok: true, remaining: gate.remaining });
  return json({ ok: false, reason: gate.reason === "daily_cap" || gate.reason === "not_premium" ? "capped" : "off", cause: gate.reason });
}

/** The usage route (`http.ts`) → `{ ok: true }` once the row is written: what the gateway decided for this chat. */
export async function agentTextsDecideUsageHandler(ctx: ActionCtx, raw: Record<string, unknown>): Promise<Response> {
  const chat = chatOf(raw);
  const report = {
    calls: count(raw.calls),
    failed: count(raw.failed),
    refused: count(raw.refused),
    questions: count(raw.questions, MAX_REPORTED * 16),
    chars: count(raw.chars, MAX_REPORTED * 64_000),
    ms: count(raw.ms, MAX_REPORTED * 60_000),
  };
  if (chat === null || Object.values(report).some((value) => value === null)) return badRequest();
  const workspaceId = await workspaceFor(ctx, chat as DecideBody);
  if (workspaceId === null) return json({ ok: false });
  await recordDecidedElsewhere(ctx, workspaceId, report as { [K in keyof typeof report]: number });
  return json({ ok: true });
}
