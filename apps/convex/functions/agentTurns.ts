/**
 * THE AGENT'S TURN LOG: how long each turn took and which tools it called.
 *
 * The gateway reports every finished turn of its `/agent` route here, for the
 * texting assistant and the app's agent alike, so a slow or failing agent can
 * be seen and improved rather than guessed at (asked for by the owner,
 * 2026-10-07). Reported after the answer has gone, where the host allows it,
 * so the log never costs anybody their reply.
 *
 * Never text. The gateway sends names, outcomes, durations and token counts;
 * this file accepts nothing else, and the shape is pinned by its validators:
 * a tool name must look like a tool name, so an argument or a sentence cannot
 * be smuggled in where a name goes.
 */

import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { resolveGrantByAccessTokenHandler } from "./lib/controlPlane/session";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { writingCostMicroUsd } from "./lib/jev/meter";

/** How long a turn's row is kept. Long enough to compare weeks, no longer. */
export const AGENT_TURN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A turn is at most eight model rounds and the tool calls between them. */
export const MAX_TRACE_ENTRIES = 64;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL = /^[\w@./:-]{1,128}$/;
const MAX_MS = 15 * 60 * 1000;
/** A text's wait before its turn, clamped at a day like the gateway's own cut (`apps/mcp/src/agent/turnLog.js`). */
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const MAX_TOKENS = 2_000_000;

const count = (n: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(0, Math.floor(n))) : 0);

export const traceEntryValidator = v.object({
  kind: v.union(v.literal("model"), v.literal("tool"), v.literal("router"), v.literal("fallback")),
  tool: v.optional(v.string()),
  tier: v.optional(v.union(v.literal("main"), v.literal("think"))),
  confidence: v.optional(v.number()),
  model: v.optional(v.string()),
  status: v.optional(v.number()),
  retried: v.optional(v.boolean()),
  cut: v.optional(v.boolean()),
  held: v.optional(v.boolean()),
  ok: v.boolean(),
  ms: v.number(),
});

/** Where a turn came from, as the gateway names it (`apps/mcp/src/agent/turnLog.js`). */
export const TURN_KINDS = ["one", "group", "job", "routine", "app"] as const;
export const turnKindValidator = v.union(v.literal("one"), v.literal("group"), v.literal("job"), v.literal("routine"), v.literal("app"));

/** One model's share of a turn, as the gateway's `meterParts` splits it (`modelPlan.js`). */
export const modelUsageValidator = v.object({
  model: v.string(),
  input: v.number(),
  output: v.number(),
  cacheRead: v.number(),
  cacheWrite: v.number(),
});

/** A turn runs on its main model, a thinking model and a fallback at most. */
export const MAX_MODELS_PER_TURN = 4;

const STATUS = (n: number | undefined) => (n === undefined ? {} : { status: count(n, 999) });

export const recordAgentTurn = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.union(v.string(), v.null()),
    provider: v.string(),
    model: v.string(),
    outcome: v.union(v.literal("answered"), v.literal("exhausted"), v.literal("failed")),
    ms: v.number(),
    waitMs: v.optional(v.number()),
    modelMs: v.number(),
    toolMs: v.number(),
    rounds: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    kind: v.optional(turnKindValidator),
    usage: v.optional(v.array(modelUsageValidator)),
    trace: v.array(traceEntryValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken: args.hashedAccessToken });
    if (session === null) return false;
    // The turn belongs to the workspace the grant answers in, and only that one.
    if (args.expectedWorkspaceId !== null && args.expectedWorkspaceId !== session.workspaceId) return false;
    if (args.trace.length > MAX_TRACE_ENTRIES) return false;
    if (!PROVIDER.test(args.provider) || !MODEL.test(args.model)) return false;
    if (args.usage !== undefined && (args.usage.length > MAX_MODELS_PER_TURN || args.usage.some((part) => !MODEL.test(part.model)))) return false;

    const trace = [];
    for (const entry of args.trace) {
      const ms = count(entry.ms, MAX_MS);
      if (entry.kind === "tool") {
        if (entry.tool === undefined || !TOOL_NAME.test(entry.tool)) return false;
        trace.push({ kind: "tool" as const, tool: entry.tool, ok: entry.ok, ms, ...(entry.held ? { held: true } : {}) });
      } else if (entry.kind === "router") {
        // The router's pick (`src/agent/router.js`): which tier, and so which model, answered.
        if (entry.tool !== undefined || entry.tier === undefined || entry.model === undefined || !MODEL.test(entry.model)) return false;
        // How sure it was that the text needs thinking, 0 to 1, when it said so.
        if (entry.confidence !== undefined && !(entry.confidence >= 0 && entry.confidence <= 1)) return false;
        trace.push({ kind: "router" as const, tier: entry.tier, model: entry.model, ok: entry.ok, ms, ...(entry.confidence === undefined ? {} : { confidence: entry.confidence }) });
      } else if (entry.kind === "fallback") {
        // The turn went on with the setup's fallback model after the one it was on failed.
        if (entry.tool !== undefined || entry.model === undefined || !MODEL.test(entry.model)) return false;
        trace.push({ kind: "fallback" as const, model: entry.model, ok: entry.ok, ms, ...STATUS(entry.status) });
      } else {
        if (entry.tool !== undefined) return false;
        // Which model ran the round, when the gateway says: a planned turn runs on two.
        if (entry.model !== undefined && !MODEL.test(entry.model)) return false;
        trace.push({ kind: "model" as const, ok: entry.ok, ms, ...(entry.model === undefined ? {} : { model: entry.model }), ...(entry.retried ? { retried: true } : {}), ...(entry.cut ? { cut: true } : {}), ...STATUS(entry.status) });
      }
    }

    await ctx.db.insert("agentTurns", {
      workspaceId: session.workspaceId,
      grantId: session.grantId,
      client: session.clientId === TEXTS_CLIENT_ID ? "texts" : "app",
      provider: args.provider,
      model: args.model,
      outcome: args.outcome,
      at: Date.now(),
      ms: count(args.ms, MAX_MS),
      ...(args.waitMs === undefined ? {} : { waitMs: count(args.waitMs, MAX_WAIT_MS) }),
      modelMs: count(args.modelMs, MAX_MS),
      toolMs: count(args.toolMs, MAX_MS),
      rounds: count(args.rounds, 64),
      inputTokens: count(args.inputTokens, MAX_TOKENS),
      outputTokens: count(args.outputTokens, MAX_TOKENS),
      ...(args.kind === undefined ? {} : { kind: args.kind }),
      ...spendOf(args),
      trace,
    });
    return true;
  },
});

/**
 * The turn's cache tokens and list-price cost, per model when the gateway sent
 * each model's counts, else from the turn's own counts on its answering model.
 * Every count is clamped as the turn's own are, so a wild number costs a row
 * its accuracy, never the table its shape.
 */
function spendOf(args: { model: string; inputTokens: number; outputTokens: number; usage?: Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite: number }> }) {
  if (args.usage === undefined || args.usage.length === 0) {
    return { costMicroUsd: writingCostMicroUsd({ input: count(args.inputTokens, MAX_TOKENS), output: count(args.outputTokens, MAX_TOKENS), model: args.model }) };
  }
  const models = args.usage.map((part) => {
    const spent = {
      inputTokens: count(part.input, MAX_TOKENS),
      outputTokens: count(part.output, MAX_TOKENS),
      cacheReadTokens: count(part.cacheRead, MAX_TOKENS),
      cacheWriteTokens: count(part.cacheWrite, MAX_TOKENS),
    };
    const costMicroUsd = writingCostMicroUsd({ input: spent.inputTokens, output: spent.outputTokens, cacheRead: spent.cacheReadTokens, cacheWrite: spent.cacheWriteTokens, model: part.model });
    return { model: part.model, ...spent, costMicroUsd };
  });
  const sum = (key: "cacheReadTokens" | "cacheWriteTokens" | "costMicroUsd") => models.reduce((total, part) => total + part[key], 0);
  return { cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens"), costMicroUsd: sum("costMicroUsd"), models };
}

/** Drop turns past their retention, a batch at a time (crons.ts). */
export const purgeOldAgentTurns = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("agentTurns")
      .withIndex("by_at", (q) => q.lt("at", Date.now() - AGENT_TURN_RETENTION_MS))
      .take(500);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});
