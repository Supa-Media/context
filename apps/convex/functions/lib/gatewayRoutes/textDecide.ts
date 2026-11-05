/**
 * The texting Worker's decision route (`docs/design/tex-event-log/CONTRACT.md` section 3): whether Tex stays
 * silent, reacts or answers in a chat, which messages an answer covers, what a text sent mid-turn does, which held
 * asks it makes stale, and whether the chat has moved on. Behind `AGENT_WORKER_SECRET`, like the rest of
 * `/agent-texts/*`; asked of the decision model through `withJev` as `textDecide`, typed questions only.
 *
 * Group chats (and the engagement choice, `/agent-texts/group/engagement`) are named by `line` and `chat` (the
 * group id), hashed as `/agent-texts/group` hashes them; a 1:1 text by its `sender`. The transcript is never
 * returned, stored or logged: the one log line carries counts and codes.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { ENGAGEMENT_STYLES, groupKeyOf, type Engagement } from "../../textGroups";
import { badRequest, json, stringField } from "../gatewayAuth";
import { withJev } from "../jev/client";
// Routed beside decide (`http.ts` is at its size limit): the last look before a group answer sends.
export { agentTextsRecheckHandler } from "./textRecheck";
// And decide's cap and usage when the gateway asks Clef itself.
export { agentTextsDecideGateHandler, agentTextsDecideUsageHandler } from "./textDecideMeter";

export {
  ADDRESSED_RULE,
  decideRequest,
  MAX_CANDIDATES,
  MAX_TRANSCRIPT,
  MAX_WAITING_ASKS,
  OTHER_ASSISTANT_RULE,
  readDecideAnswers,
  readDecideBody,
  STALE_AT,
  STYLES,
  WAIT_SECOND_LEVELS,
} from "@context/shared/src/textDecide.cjs";
export type { DecideBody, DecideResult, Style } from "@context/shared/src/textDecide.cjs";
/** Sendblue's group ids are uuids; anything much longer is not one (as `/agent-texts/group`). */
const MAX_CHAT = 200;
// The questions and how answers read are one copy, shared with the gateway (`packages/shared/src/textDecide.cjs`).
import { decideRequest, readDecideAnswers, readDecideBody, type DecideBody, type DecideResult } from "@context/shared/src/textDecide.cjs";

/** The workspace a decision is metered against: the sender's personal one in a 1:1 chat, the bound one in a group. */
export async function workspaceFor(ctx: ActionCtx, body: DecideBody): Promise<Id<"workspaces"> | null> {
  if (body.style === "direct") return await ctx.runQuery(internal.functions.textLinks.textsDecideWorkspace, { phone: body.sender! });
  return await ctx.runQuery(internal.functions.textGroups.groupDecideWorkspace, { groupKey: await groupKeyOf(body.line!, body.chat) });
}

export async function agentTextsDecideHandler(ctx: ActionCtx, raw: Record<string, unknown>): Promise<Response> {
  const body = readDecideBody(raw);
  if (body === null) return badRequest();
  // Each hop timed, so a slow decide says where the time went (2026-10-27: every group decide ran past the Worker's 4s).
  const started = Date.now();
  const workspaceId = await workspaceFor(ctx, body);
  const lookupMs = Date.now() - started;
  let modelMs: number | undefined;
  const result: DecideResult =
    workspaceId === null
      ? { ok: false, reason: "unavailable", cause: "no_group" }
      : await withJev(ctx, { feature: "textDecide", workspaceId }, async (jev, refusal) => {
          if (!jev) return { ok: false, reason: refusal === "daily_cap" || refusal === "not_premium" ? "capped" : refusal === "unconfigured" ? "unavailable" : "off", cause: refusal ?? "refused" };
          if (jev.remaining <= 0) return { ok: false, reason: "capped", cause: "daily_cap" };
          const asked = Date.now();
          const answers = await jev.decide(decideRequest(body));
          modelMs = Date.now() - asked;
          return answers === null ? { ok: false, reason: "unavailable", cause: "model_failed" } : readDecideAnswers(body, answers);
        });
  // Counts and codes only: never the transcript, a candidate's words, or a number.
  console.info(
    JSON.stringify({
      event: "texts.decide",
      style: body.style,
      candidates: body.candidates.length,
      waitingAsks: body.waitingAsks.length,
      running: body.running,
      lookupMs,
      ...(modelMs !== undefined ? { modelMs } : {}),
      totalMs: Date.now() - started,
      ...(result.ok ? { act: result.act, covers: result.covers.length, stale: result.stale.length } : { reason: result.reason, cause: result.cause }),
    }),
  );
  return json(result);
}

/** `POST /agent-texts/group/engagement` `{ line, groupId, style, setBy }` → `{ ok: true }`, or `{ ok: false }` for a chat Tex has no row for. */
export async function agentTextsGroupEngagementHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const line = stringField(body, "line");
  const groupId = stringField(body, "groupId");
  const setBy = stringField(body, "setBy");
  const style = body.style;
  if (line === null || groupId === null || groupId.length > MAX_CHAT || setBy === null || setBy.length > 320) return badRequest();
  if (typeof style !== "string" || !(ENGAGEMENT_STYLES as readonly string[]).includes(style)) return badRequest();
  const outcome = await ctx.runMutation(internal.functions.textGroups.setGroupEngagement, {
    groupKey: await groupKeyOf(line, groupId),
    style: style as Engagement,
    setBy,
  });
  return json(outcome === "set" ? { ok: true } : { ok: false });
}
