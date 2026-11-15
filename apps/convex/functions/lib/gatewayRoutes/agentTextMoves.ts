/**
 * `POST /agent-texts/moves` and `/agent-texts/move-report`: the texting Worker's half of moving chats to Tex's new
 * number one at a time (`functions/texChatMoves.ts`, `apps/agent/src/moveChats.ts`), behind the Worker's own secret
 * (`agentWorkerRoute`, `http.ts`).
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { badRequest, json, stringField } from "../gatewayAuth";

/**
 * `POST /agent-texts/moves` — `{}` → `{ moves: [{ kind, key, askedAt }], number, archiveOn }`: the moves staff asked for,
 * now being sent, and the new number they go to (the Lines page's saved number, `functions/texOldLine.ts`).
 */
export async function agentTextsMovesHandler(ctx: ActionCtx): Promise<Response> {
  const setting = await ctx.runQuery(internal.functions.texOldLine.oldLineForWorker, {});
  const moves = await ctx.runMutation(internal.functions.texChatMoves.claimTexChatMoves, { now: Date.now() });
  return json({ moves, number: setting.number, archiveOn: setting.archiveOn });
}

/** `POST /agent-texts/move-report` — `{ kind, key, status, askedAt?, detail? }` → `{ outcome: "noted" | "stale" | "no_move" }`. */
export async function agentTextsMoveReportHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const kind = stringField(body, "kind");
  const key = stringField(body, "key");
  const status = stringField(body, "status");
  const detail = body.detail === undefined ? undefined : stringField(body, "detail");
  const askedAt = body.askedAt;
  if ((kind !== "person" && kind !== "group") || key === null || key.length > 200) return badRequest();
  if (status !== "told" && status !== "moved" && status !== "failed") return badRequest();
  if (detail === null || (detail !== undefined && !/^[a-z_]{1,40}$/.test(detail))) return badRequest();
  if (askedAt !== undefined && (typeof askedAt !== "number" || !Number.isSafeInteger(askedAt))) return badRequest();
  const outcome = await ctx.runMutation(internal.functions.texChatMoves.reportTexChatMove, {
    kind,
    key,
    status,
    now: Date.now(),
    ...(typeof askedAt === "number" ? { askedAt } : {}),
    ...(detail !== undefined ? { detail } : {}),
  });
  return json({ outcome });
}
