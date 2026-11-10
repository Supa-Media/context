import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * One row per failed Tex tool call, so the team can see why tools fail and
 * whether a fix held (Dev2, 2026-11-10: "whenever there is a tool call
 * failure, I want it logged and visible for us to understand why").
 *
 * NAMES NOBODY. No workspace, grant, chat or person, and `at` is kept to the
 * hour, so a row cannot be laid beside a turn row to find whose it was. `why`
 * is the reason with every value taken out by the gateway
 * (`apps/mcp/src/agent/toolFailures.js` `failureShape`): the sentence our code
 * wrote, never the path, quote or search it was about. Kept
 * `TOOL_FAILURE_RETENTION_MS` (`functions/texToolFailures.ts`).
 */
export const texToolFailureTables = {
  texToolFailures: defineTable({
    /** The hour it happened, UTC, in milliseconds. */
    at: v.number(),
    /** `YYYY-MM-DD`, UTC. */
    day: v.string(),
    /** Where it ran: `one`, `group`, `job`, `routine`, `app` or `check_in`. */
    kind: v.string(),
    tool: v.string(),
    /** One of `TOOL_FAILURE_CAUSES`. */
    cause: v.string(),
    why: v.string(),
    /** The model that made the call, when the gateway said. */
    model: v.optional(v.string()),
  })
    .index("by_at", ["at"])
    .index("by_tool_at", ["tool", "at"]),
};
