import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * One row per agent turn: where its time went and which tools it called, so
 * the agent can be audited and made faster (asked for by the owner,
 * 2026-10-07: "see how much time and what tool calls are being made").
 *
 * METADATA ONLY, like every table here. Never the question, the answer, a
 * tool's arguments or its result: a tool's name, whether it worked and how
 * long it took is what makes a slow turn diagnosable, and an argument is a
 * path or a query, which is a fact about what somebody looks for in their
 * own notes. Kept `AGENT_TURN_RETENTION_MS` (`functions/agentTurns.ts`).
 */
export const agentTurnTables = {
  agentTurns: defineTable({
    workspaceId: v.id("workspaces"),
    grantId: v.id("oauthGrants"),
    /** Which client asked: the texting assistant or the app's own agent. */
    client: v.union(v.literal("texts"), v.literal("app")),
    provider: v.string(),
    model: v.string(),
    outcome: v.union(v.literal("answered"), v.literal("exhausted"), v.literal("failed")),
    at: v.number(),
    /** Whole request, model calls and tool calls, in milliseconds. */
    ms: v.number(),
    modelMs: v.number(),
    toolMs: v.number(),
    rounds: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    /** In order: each model round, and each tool call between them. */
    trace: v.array(
      v.object({
        kind: v.union(v.literal("model"), v.literal("tool")),
        tool: v.optional(v.string()),
        ok: v.boolean(),
        ms: v.number(),
      }),
    ),
  })
    .index("by_at", ["at"])
    .index("by_workspace_at", ["workspaceId", "at"]),
};
