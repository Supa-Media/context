/**
 * WHY TEX'S TOOL CALLS FAIL: one anonymous row per failed call, for tex.lc/admin's
 * "Why tools fail" (Dev2, 2026-11-10; `docs/decisions/observability/tool-failures.md`).
 *
 * The gateway sends each failure as a tool name, a cause code and the reason
 * with every value taken out (`apps/mcp/src/agent/toolFailures.js`). A grant
 * proves a live connection asked; the row keeps nothing of it. The shape is
 * pinned here as well as there: a name must look like a tool's, a cause must
 * be one of ours, and the reason loses anything that still looks like a value
 * (a link, an address, a handle, a number) and is cut to one short line.
 */

import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { resolveGrantByAccessTokenHandler } from "./lib/controlPlane/session";
import { dayKey } from "./lib/usage";

/** Long enough to see a fix hold over weeks; the dashboard's widest window is 90 days. */
export const TOOL_FAILURE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_FAILURES_PER_REPORT = 20;
export const MAX_WHY = 160;

export const TOOL_FAILURE_CAUSES = ["refused", "threw", "timed_out", "out_of_time", "not_offered", "no_such_action", "repeated"] as const;
export const TOOL_FAILURE_KINDS = ["one", "group", "job", "routine", "app", "check_in"] as const;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MODEL = /^[\w@./:-]{1,128}$/;
const HOUR_MS = 60 * 60 * 1000;

export const toolFailureValidator = v.object({
  tool: v.string(),
  cause: v.string(),
  why: v.string(),
  model: v.optional(v.string()),
});

/** The reason as it is kept: one line, no values left in it, at most `MAX_WHY` characters. */
export function keptWhy(why: string): string {
  const line = why
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "<email>")
    .replace(/(^|[\s(\[])@[\w.-]+/g, "$1<@>")
    .replace(/\d+/g, "<n>")
    .replace(/(<n>[\s().:,/-]*)+<n>/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return (line.length > MAX_WHY ? `${line.slice(0, MAX_WHY - 1)}…` : line) || "(no reason given)";
}

export const recordToolFailures = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.union(v.string(), v.null()),
    kind: v.string(),
    failures: v.array(toolFailureValidator),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken: args.hashedAccessToken });
    if (session === null) return 0;
    if (args.expectedWorkspaceId !== null && args.expectedWorkspaceId !== session.workspaceId) return 0;
    if (!(TOOL_FAILURE_KINDS as readonly string[]).includes(args.kind)) return 0;
    const at = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    let kept = 0;
    for (const failure of args.failures.slice(0, MAX_FAILURES_PER_REPORT)) {
      if (!TOOL_NAME.test(failure.tool) || !(TOOL_FAILURE_CAUSES as readonly string[]).includes(failure.cause)) continue;
      await ctx.db.insert("texToolFailures", {
        at,
        day: dayKey(at),
        kind: args.kind,
        tool: failure.tool,
        cause: failure.cause,
        why: keptWhy(failure.why),
        ...(failure.model !== undefined && MODEL.test(failure.model) ? { model: failure.model } : {}),
      });
      kept += 1;
    }
    return kept;
  },
});

/** Drop failures past their retention, a batch at a time (crons.ts). */
export const purgeOldToolFailures = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("texToolFailures")
      .withIndex("by_at", (q) => q.lt("at", Date.now() - TOOL_FAILURE_RETENTION_MS))
      .take(500);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});
