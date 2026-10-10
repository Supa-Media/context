/**
 * THE BUILT-IN MODEL: WHO MAY SPEND OURS, AND THE METER.
 *
 * The assistant runs on a model we pay for, for a Premium workspace, up to a
 * daily cap (decided by the owner, 2026-10-06: "Premium, capped"). It is the
 * only model: people's own Anthropic and OpenAI keys were deleted and are no
 * longer used (the owner, 2026-10-10; `providers.ts`). Everyone else is told
 * the assistant is not available to them.
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
 * agent panel is refused here, so since 2026-10-10 it has no model at all;
 * widening this set to it is a product decision, not a line here.
 *
 * Nothing about the conversation reaches this file. The gateway reports token
 * counts after a turn, never text.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { countTurn, recordTurn, resolveTurn } from "./lib/jev/turns";
import { GLM_MODEL } from "./lib/jev/models";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { ROUTINES_CLIENT_ID } from "./lib/routines/model";

/** The clients that may spend the built-in model. Nothing else, whatever its plan. */
const BUILTIN_CLIENTS: ReadonlySet<string> = new Set([TEXTS_CLIENT_ID, ROUTINES_CLIENT_ID]);

/** The meter's name for this feature. Permanent: usage and switches are keyed by it. */
export const BUILTIN_FEATURE = "assistant" as const;

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
  const turn = await resolveTurn(ctx, hashedAccessToken, expectedWorkspaceId);
  if (turn === null) return null;
  if (!BUILTIN_CLIENTS.has(turn.clientId)) return { refused: "not_texts" };
  return { workspaceId: turn.workspaceId };
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
    return await countTurn(ctx, BUILTIN_FEATURE, charged.workspaceId, Date.now());
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
    await recordTurn(ctx, BUILTIN_FEATURE, charged.workspaceId, args, GLM_MODEL, Date.now());
    return true;
  },
});
