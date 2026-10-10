import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, nullableStringField, stringField } from "../gatewayAuth";

type TraceEntry = {
  kind: "model" | "tool" | "router" | "fallback";
  tool?: string;
  tier?: "main" | "think";
  model?: string;
  status?: number;
  retried?: boolean;
  held?: boolean;
  ok: boolean;
  ms: number;
};

/**
 * The trace as the gateway's `wireTraceEntry` (`apps/mcp/src/agent/route.js`)
 * sends it: kinds, names, numbers and flags. Anything else on an entry is
 * dropped here, before the mutation's validator ever sees it, so a field this
 * handler does not know can never carry a provider's words into the log.
 */
function traceOf(value: unknown): TraceEntry[] | null {
  if (!Array.isArray(value)) return null;
  const trace: TraceEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { kind, tool, tier, model, status, retried, held, ok, ms } = entry as Record<string, unknown>;
    if (kind !== "model" && kind !== "tool" && kind !== "router" && kind !== "fallback") return null;
    if (typeof ok !== "boolean" || typeof ms !== "number") return null;
    if (tool !== undefined && typeof tool !== "string") return null;
    if (tier !== undefined && tier !== "main" && tier !== "think") return null;
    if (model !== undefined && typeof model !== "string") return null;
    if (status !== undefined && typeof status !== "number") return null;
    if (retried !== undefined && typeof retried !== "boolean") return null;
    if (held !== undefined && typeof held !== "boolean") return null;
    trace.push({
      kind,
      ok,
      ms,
      ...(tool === undefined ? {} : { tool }),
      ...(tier === undefined ? {} : { tier }),
      ...(model === undefined ? {} : { model }),
      ...(status === undefined ? {} : { status }),
      ...(retried === undefined ? {} : { retried }),
      ...(held === undefined ? {} : { held }),
    });
  }
  return trace;
}

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
