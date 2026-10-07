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
import { internalMutation } from "../_generated/server";
import { resolveGrantByAccessTokenHandler } from "./lib/controlPlane/session";
import { TEXTS_CLIENT_ID } from "./textLinks";

/** How long a turn's row is kept. Long enough to compare weeks, no longer. */
export const AGENT_TURN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A turn is at most eight model rounds and the tool calls between them. */
export const MAX_TRACE_ENTRIES = 64;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL = /^[\w@./:-]{1,128}$/;
const MAX_MS = 15 * 60 * 1000;
const MAX_TOKENS = 2_000_000;

const count = (n: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(0, Math.floor(n))) : 0);

export const traceEntryValidator = v.object({
  kind: v.union(v.literal("model"), v.literal("tool")),
  tool: v.optional(v.string()),
  ok: v.boolean(),
  ms: v.number(),
});

export const recordAgentTurn = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.union(v.string(), v.null()),
    provider: v.string(),
    model: v.string(),
    outcome: v.union(v.literal("answered"), v.literal("exhausted"), v.literal("failed")),
    ms: v.number(),
    modelMs: v.number(),
    toolMs: v.number(),
    rounds: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
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

    const trace = [];
    for (const entry of args.trace) {
      if (entry.kind === "tool") {
        if (entry.tool === undefined || !TOOL_NAME.test(entry.tool)) return false;
        trace.push({ kind: "tool" as const, tool: entry.tool, ok: entry.ok, ms: count(entry.ms, MAX_MS) });
      } else {
        if (entry.tool !== undefined) return false;
        trace.push({ kind: "model" as const, ok: entry.ok, ms: count(entry.ms, MAX_MS) });
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
      modelMs: count(args.modelMs, MAX_MS),
      toolMs: count(args.toolMs, MAX_MS),
      rounds: count(args.rounds, 64),
      inputTokens: count(args.inputTokens, MAX_TOKENS),
      outputTokens: count(args.outputTokens, MAX_TOKENS),
      trace,
    });
    return true;
  },
});

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
