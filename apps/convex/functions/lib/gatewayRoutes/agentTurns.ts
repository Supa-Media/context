import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, nullableStringField, stringField } from "../gatewayAuth";

type TraceEntry = {
  kind: "model" | "tool" | "router" | "fallback";
  tool?: string;
  action?: string;
  tier?: "main" | "think";
  confidence?: number;
  model?: string;
  status?: number;
  retried?: boolean;
  cut?: boolean;
  held?: boolean;
  ok: boolean;
  ms: number;
};

/**
 * The trace as the gateway's `wireTraceEntry` (`apps/mcp/src/agent/turnLog.js`)
 * sends it: kinds, names, numbers and flags. Anything else on an entry is
 * dropped here, before the mutation's validator ever sees it, so a field this
 * handler does not know can never carry a provider's words into the log.
 */
function traceOf(value: unknown): TraceEntry[] | null {
  if (!Array.isArray(value)) return null;
  const trace: TraceEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { kind, tool, action, tier, confidence, model, status, retried, cut, held, ok, ms } = entry as Record<string, unknown>;
    // A reply gate's verdict (`replyJudge.js` via `wireTraceEntry`): kept in the chat's history
    // (`judgeEvent`), not in this log. Skipped, so a judged turn keeps its row and its priced usage.
    if (kind === "judge") continue;
    if (kind !== "model" && kind !== "tool" && kind !== "router" && kind !== "fallback") return null;
    if (typeof ok !== "boolean" || typeof ms !== "number") return null;
    if (tool !== undefined && typeof tool !== "string") return null;
    if (action !== undefined && typeof action !== "string") return null;
    if (tier !== undefined && tier !== "main" && tier !== "think") return null;
    if (confidence !== undefined && typeof confidence !== "number") return null;
    if (model !== undefined && typeof model !== "string") return null;
    if (status !== undefined && typeof status !== "number") return null;
    if (retried !== undefined && typeof retried !== "boolean") return null;
    if (cut !== undefined && typeof cut !== "boolean") return null;
    if (held !== undefined && typeof held !== "boolean") return null;
    trace.push({
      kind,
      ok,
      ms,
      ...(tool === undefined ? {} : { tool }),
      ...(action === undefined ? {} : { action }),
      ...(tier === undefined ? {} : { tier }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(model === undefined ? {} : { model }),
      ...(status === undefined ? {} : { status }),
      ...(retried === undefined ? {} : { retried }),
      ...(cut === undefined ? {} : { cut }),
      ...(held === undefined ? {} : { held }),
    });
  }
  return trace;
}

const KINDS = new Set(["one", "group", "job", "routine", "app"]);
type TurnKind = "one" | "group" | "job" | "routine" | "app";
type ModelUsage = { model: string; input: number; output: number; cacheRead: number; cacheWrite: number };

/** Each model's counts, numbers only; a malformed list is dropped, never the turn. */
function usageOf(value: unknown): ModelUsage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: ModelUsage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { model, input, output, cacheRead, cacheWrite } = entry as Record<string, unknown>;
    if (typeof model !== "string") return undefined;
    const n = (x: unknown) => (typeof x === "number" ? x : 0);
    parts.push({ model, input: n(input), output: n(output), cacheRead: n(cacheRead), cacheWrite: n(cacheWrite) });
  }
  return parts;
}

export async function gatewayAgentTurnHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = nullableStringField(body, "expectedWorkspaceId");
  const provider = stringField(body, "provider");
  const model = stringField(body, "model");
  const outcome = body.outcome;
  const trace = traceOf(body.trace);
  const num = (key: string) => (typeof body[key] === "number" ? (body[key] as number) : 0);
  const usage = usageOf(body.usage);
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
    ...(typeof body.waitMs === "number" ? { waitMs: body.waitMs } : {}),
    modelMs: num("modelMs"),
    toolMs: num("toolMs"),
    rounds: num("rounds"),
    inputTokens: num("inputTokens"),
    outputTokens: num("outputTokens"),
    ...(typeof body.kind === "string" && KINDS.has(body.kind) ? { kind: body.kind as TurnKind } : {}),
    ...(usage === undefined ? {} : { usage }),
    trace,
  });
  return json({ recorded });
}

/**
 * POST /gateway/tool-failures: a run's failed tool calls, kept with nobody on
 * them (`functions/texToolFailures.ts`). An entry out of shape is dropped, a
 * body out of shape keeps nothing; the answer is how many were kept.
 */
export async function gatewayToolFailuresHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = nullableStringField(body, "expectedWorkspaceId");
  const kind = typeof body.kind === "string" ? body.kind : null;
  if (accessToken === null || !expected.ok || kind === null || !Array.isArray(body.failures)) return json({ kept: 0 });
  const failures: Array<{ tool: string; cause: string; why: string; model?: string }> = [];
  for (const entry of body.failures.slice(0, 20)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { tool, cause, why, model } = entry as Record<string, unknown>;
    if (typeof tool !== "string" || typeof cause !== "string" || typeof why !== "string") continue;
    failures.push({ tool: tool.slice(0, 64), cause: cause.slice(0, 32), why: why.slice(0, 400), ...(typeof model === "string" ? { model: model.slice(0, 128) } : {}) });
  }
  if (failures.length === 0) return json({ kept: 0 });
  const kept = await ctx.runMutation(internal.functions.texToolFailures.recordToolFailures, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected.value,
    kind,
    failures,
  });
  return json({ kept });
}
