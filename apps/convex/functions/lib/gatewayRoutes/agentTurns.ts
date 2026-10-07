import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, nullableStringField, stringField } from "../gatewayAuth";

type TraceEntry = { kind: "model" | "tool"; tool?: string; ok: boolean; ms: number };

/** The trace as sent, or null for any entry that is not exactly the shape. */
function traceOf(value: unknown): TraceEntry[] | null {
  if (!Array.isArray(value)) return null;
  const trace: TraceEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { kind, tool, ok, ms } = entry as Record<string, unknown>;
    if ((kind !== "model" && kind !== "tool") || typeof ok !== "boolean" || typeof ms !== "number") return null;
    if (tool !== undefined && typeof tool !== "string") return null;
    trace.push(tool === undefined ? { kind, ok, ms } : { kind, tool, ok, ms });
  }
  return trace;
}

/**
 * POST /gateway/agent-turn — one finished agent turn, for the turn log
 * (`functions/agentTurns.ts`). Behind the gateway's own secret, with the
 * person's access token as the second proof. Names and numbers only.
 */
export async function gatewayAgentTurnHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = nullableStringField(body, "expectedWorkspaceId");
  const provider = stringField(body, "provider");
  const model = stringField(body, "model");
  const outcome = body.outcome;
  const trace = traceOf(body.trace);
  const num = (key: string) => (typeof body[key] === "number" ? (body[key] as number) : 0);
  if (
    accessToken === null ||
    !expected.ok ||
    provider === null ||
    model === null ||
    trace === null ||
    (outcome !== "answered" && outcome !== "exhausted" && outcome !== "failed")
  ) {
    return json({ recorded: false });
  }
  const recorded = await ctx.runMutation(internal.functions.agentTurns.recordAgentTurn, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected.value,
    provider,
    model,
    outcome,
    ms: num("ms"),
    modelMs: num("modelMs"),
    toolMs: num("toolMs"),
    rounds: num("rounds"),
    inputTokens: num("inputTokens"),
    outputTokens: num("outputTokens"),
    trace,
  });
  return json({ recorded });
}
