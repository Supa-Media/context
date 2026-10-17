/**
 * Looking a domain up before it is connected: which company runs its DNS,
 * where its zone starts, whether its root can point at us there, and what it
 * answers today. The settings screen asks as the owner types, so it can
 * recommend an address that will work at that company and warn before an
 * existing website is replaced.
 *
 * Public DNS only (`lib/customDomains/survey.ts`); no credential is opened
 * and nothing is written but the caller's rate-limit count.
 */

import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { describeHostnameRejection, normalizeHostname } from "./lib/customDomains/hostname";
import { lookupDomain } from "./lib/customDomains/survey";

const answerValidator = v.union(
  v.object({ kind: v.literal("empty") }),
  v.object({ kind: v.literal("ours") }),
  v.object({ kind: v.literal("site"), site: v.string() }),
  v.object({ kind: v.literal("parked") }),
  v.object({ kind: v.literal("elsewhere"), value: v.string() }),
);

export const lookupValidator = v.union(
  v.object({ ok: v.literal(false), message: v.string() }),
  v.object({
    ok: v.literal(true),
    hostname: v.string(),
    zone: v.string(),
    apex: v.boolean(),
    dnsHost: v.union(v.object({ key: v.string(), name: v.string() }), v.null()),
    rootCanPoint: v.union(v.boolean(), v.null()),
    current: v.union(answerValidator, v.null()),
    wwwCurrent: v.union(answerValidator, v.null()),
  }),
);

export const lookup = action({
  args: { workspaceId: v.id("workspaces"), hostname: v.string() },
  returns: lookupValidator,
  handler: async (ctx, args): Promise<Infer<typeof lookupValidator>> => {
    const normalized = normalizeHostname(args.hostname);
    if (!normalized.ok) return { ok: false as const, message: describeHostnameRejection(normalized.reason) };
    const { target }: { target: string } = await ctx.runMutation(internal.functions.customDomains.admitLookup, {
      workspaceId: args.workspaceId,
    });
    return { ok: true as const, ...(await lookupDomain(normalized.hostname, target)) };
  },
});
