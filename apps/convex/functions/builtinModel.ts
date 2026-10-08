/**
 * THE BUILT-IN MODEL: WHO MAY SPEND OURS, AND THE METER.
 *
 * The texting assistant answers with the person's own Anthropic or OpenAI key
 * when one is connected. When none is, a Premium workspace gets a cheap model
 * we run on Workers AI, up to a daily cap (decided by the owner, 2026-10-06:
 * "Premium, capped"). Everyone else is told to connect an account.
 *
 * The gateway makes the model call, because the turn's tools run there. What it
 * may not do is decide whether the call is allowed: that is this file, through
 * the same Jev gate, switches and `jevUsage` meter every other paid inference
 * feature uses (`lib/jev/`). So the kill switch for this is
 * `admin.setJevSwitch({ feature: "assistant", off: true })`, like the rest.
 *
 * Only a grant for the texting client or the routine runner may start one: a
 * routine is the same assistant answering on a schedule instead of a text, and
 * is counted against the same cap on the workspace it runs in. The app's own
 * agent panel still needs a connected account; widening that is a product
 * decision, not a line here.
 *
 * Nothing about the conversation reaches this file. The gateway reports token
 * counts after a turn, never text.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { resolveGrantByAccessTokenHandler } from "./lib/controlPlane/session";
import { addUsage, gate, writingCostMicroUsd } from "./lib/jev/meter";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { ROUTINES_CLIENT_ID } from "./lib/routines/model";

/** The clients that may spend the built-in model. Nothing else, whatever its plan. */
const BUILTIN_CLIENTS: ReadonlySet<string> = new Set([TEXTS_CLIENT_ID, ROUTINES_CLIENT_ID]);

/** The meter's name for this feature. Permanent: usage and switches are keyed by it. */
export const BUILTIN_FEATURE = "assistant" as const;

/** Largest token count one report may carry; a turn is at most eight model calls. */
const MAX_REPORTED_TOKENS = 2_000_000;

/** The model name shape the gateway reports, e.g. "anthropic/claude-haiku-5-5". Anything else is ignored. */
const MODEL_NAME = /^[\w@./:-]{1,128}$/;

/** The model a report names, when it names a well-formed one; undefined otherwise, so it is priced as GLM. */
export function reportedModel(raw: unknown): string | undefined {
  return typeof raw === "string" && MODEL_NAME.test(raw) ? raw : undefined;
}

const refusalValidator = v.union(
  v.literal("disabled"),
  v.literal("switched_off"),
  v.literal("not_premium"),
  v.literal("daily_cap"),
  v.literal("not_texts"),
);

/**
 * The workspace a texting or routine grant's turn is charged to: the grant's own default,
 * which the gateway's `/agent` route also answers in. Null for an unknown or
 * dead token, a grant for any other client, or an expected workspace the grant
 * cannot reach.
 */
async function chargedWorkspace(
  ctx: MutationCtx,
  hashedAccessToken: string,
  expectedWorkspaceId: string | null,
): Promise<{ workspaceId: Id<"workspaces"> } | { refused: "not_texts" } | null> {
  const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken });
  if (session === null) return null;
  if (!BUILTIN_CLIENTS.has(session.clientId)) return { refused: "not_texts" };
  const wanted = expectedWorkspaceId ?? session.workspaceId;
  if (wanted !== session.workspaceId) return null;
  return { workspaceId: session.workspaceId };
}

/**
 * May this turn use the built-in model? Counts the turn as one call when it may,
 * so the cap is enforced before anything is spent rather than after.
 */
export const startBuiltinTurn = internalMutation({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.union(v.string(), v.null()) },
  returns: v.union(
    v.null(),
    v.object({ allowed: v.literal(true), remaining: v.number() }),
    v.object({ allowed: v.literal(false), reason: refusalValidator }),
  ),
  handler: async (ctx, args) => {
    const charged = await chargedWorkspace(ctx, args.hashedAccessToken, args.expectedWorkspaceId);
    if (charged === null) return null;
    if ("refused" in charged) return { allowed: false as const, reason: charged.refused };
    const now = Date.now();
    const verdict = await gate(ctx, BUILTIN_FEATURE, charged.workspaceId, now);
    const counts = { failed: 0, questions: 0, tokens: 0, ms: 0 };
    if (!verdict.allowed) {
      await addUsage(ctx, BUILTIN_FEATURE, charged.workspaceId, { ...counts, calls: 0, refused: 1 }, now);
      return verdict;
    }
    await addUsage(ctx, BUILTIN_FEATURE, charged.workspaceId, { ...counts, calls: 1, refused: 0 }, now);
    return { allowed: true as const, remaining: verdict.remaining - 1 };
  },
});

/**
 * What a finished turn spent, priced from the model's own counts, at the rate
 * of the model that answered. Best effort from the gateway's side: the turn was
 * already counted against the cap.
 * `decisionTokens` is what the turn read through Clef, which picks the next
 * page to open (apps/mcp/src/agent/computer.js); it is priced at Clef's rate
 * by `addUsage`, not the writing model's.
 */
export const recordBuiltinUsage = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.union(v.string(), v.null()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    decisionTokens: v.optional(v.number()),
    /** Prompt tokens read from the provider's cache, priced at its cache-read rate. Absent from older callers. */
    cacheReadTokens: v.optional(v.number()),
    /** Prompt tokens written to the provider's cache, priced at its cache-write rate. Absent from older callers. */
    cacheWriteTokens: v.optional(v.number()),
    /** The model that answered, priced from the table in `lib/jev/meter.ts`. Unknown or malformed: GLM's rates. */
    model: v.optional(v.string()),
    failed: v.boolean(),
    ms: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const charged = await chargedWorkspace(ctx, args.hashedAccessToken, args.expectedWorkspaceId);
    if (charged === null || "refused" in charged) return false;
    const clamp = (n: number) => (Number.isFinite(n) ? Math.min(MAX_REPORTED_TOKENS, Math.max(0, Math.floor(n))) : 0);
    const usage = {
      input: clamp(args.inputTokens),
      output: clamp(args.outputTokens),
      cacheRead: clamp(args.cacheReadTokens ?? 0),
      cacheWrite: clamp(args.cacheWriteTokens ?? 0),
      model: reportedModel(args.model),
    };
    // Cache tokens are written tokens too: priced above at their own rates, so
    // they must not be priced again at Clef's rate for `decisionTokens`.
    const written = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const tokens = written + clamp(args.decisionTokens ?? 0);
    await addUsage(
      ctx,
      BUILTIN_FEATURE,
      charged.workspaceId,
      {
        // A failed turn moves its call to `failed`, so the cap still counts it once.
        calls: args.failed ? -1 : 0,
        failed: args.failed ? 1 : 0,
        refused: 0,
        questions: 0,
        tokens,
        ms: Number.isFinite(args.ms) ? Math.max(0, Math.floor(args.ms)) : 0,
        writtenTokens: written,
        writtenMicroUsd: writingCostMicroUsd(usage),
      },
      Date.now(),
    );
    return true;
  },
});
