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
        kind: v.union(v.literal("model"), v.literal("tool"), v.literal("router"), v.literal("fallback")),
        tool: v.optional(v.string()),
        // router: the tier picked and the model it runs on; fallback: the model
        // the turn went on with. Model names only, as `model` above.
        tier: v.optional(v.union(v.literal("main"), v.literal("think"))),
        // router: how sure it was the text needs thinking (0 to 1) when it
        // said so, kept whether or not that cleared the setup's cutoff.
        confidence: v.optional(v.number()),
        model: v.optional(v.string()),
        // model: the HTTP status a failed or retried round got; fallback: the
        // status that caused it. A number, never a provider's words.
        status: v.optional(v.number()),
        retried: v.optional(v.boolean()),
        // tool: the egress gate held the call for the person's yes; it ran later or not at all.
        held: v.optional(v.boolean()),
        ok: v.boolean(),
        ms: v.number(),
      }),
    ),
  })
    .index("by_at", ["at"])
    .index("by_workspace_at", ["workspaceId", "at"]),
};
