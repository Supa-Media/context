/**
 * THE BUILT-IN MODEL: WHO MAY SPEND OURS, AND THE METER.
 *
 * The assistant runs on a model we pay for, for every workspace, up to 100
 * turns a day (decided by the owner, 2026-10-17: Tex is free, replacing
 * "Premium, capped" of 2026-10-06). It is the only model: people's own
 * Anthropic and OpenAI keys were deleted and are no longer used (the owner,
 * 2026-10-10; `providers.ts`).
 *
 * The gateway makes the model call, because the turn's tools run there. What it
 * may not do is decide whether the call is allowed: that is this file, through
 * the same Jev gate, switches and `jevUsage` meter every other paid inference
 * feature uses (`lib/jev/`). So the kill switch for this is
 * `admin.setJevSwitch({ feature: "assistant", off: true })`, like the rest.
 *
 * Only a grant for the texting client or the routine runner may start one: a
 * routine is the same assistant answering on a schedule instead of a text, and
 * is counted against the same cap on the workspace it runs in, and so is Tex's
 * nightly dream (`lib/dreams/`), one turn a night, and its daytime check-in
 * (`lib/heartbeats/`), at most three looks a day. The app's own
 * agent panel is refused here, so since 2026-10-10 it has no model at all;
 * widening this set to it is a product decision, not a line here.
 *
 * One narrow exception, for the AI tab's Try it (decided by the owner,
 * 2026-10-16: "a chatbot sort of thing … that I'm able to test it"): a console
 * grant may start a turn when the gateway says it is a Try it turn **and** its
 * person can edit `@context-lc`, whose `ai/` notes are the setups being tried.
 * The flag comes from the gateway's own route, behind the gateway secret,
 * never from the app; the role is checked here, from the grant, so a console
 * grant of anybody else is refused exactly as before. It is metered on the
 * same feature, cap and kill switch, against the grant's own workspace.
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
import { DREAMS_CLIENT_ID } from "./lib/dreams/model";
import { HEARTBEAT_CLIENT_ID } from "./lib/heartbeats/model";
import { HOUSEKEEPING_CLIENT_ID } from "./lib/housekeeping/model";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { CONSOLE_CLIENT_ID } from "./agentGrant";
import { resolveGrantByAccessTokenHandler } from "./lib/controlPlane/session";

/** The clients that may spend the built-in model. Nothing else, whatever its plan. */
const BUILTIN_CLIENTS: ReadonlySet<string> = new Set([
  TEXTS_CLIENT_ID,
  ROUTINES_CLIENT_ID,
  DREAMS_CLIENT_ID,
  HEARTBEAT_CLIENT_ID,
  HOUSEKEEPING_CLIENT_ID,
]);

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
  tryIt = false,
): Promise<{ workspaceId: Id<"workspaces"> } | { refused: "not_texts" } | null> {
  const turn = await resolveTurn(ctx, hashedAccessToken, expectedWorkspaceId);
  if (turn === null) return null;
  if (BUILTIN_CLIENTS.has(turn.clientId)) return { workspaceId: turn.workspaceId };
  if (tryIt && turn.clientId === CONSOLE_CLIENT_ID && (await editsAiNotes(ctx, hashedAccessToken))) {
    return { workspaceId: turn.workspaceId };
  }
  return { refused: "not_texts" };
}

/** Whether a grant's person is an owner or editor of `@context-lc`, whose `ai/` notes Try it runs. */
export async function editsAiNotes(ctx: MutationCtx, hashedAccessToken: string): Promise<boolean> {
  const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken });
  const pinned = session?.workspaces.find((entry) => entry.slug === PINNED_CONTEXT_SLUG);
  return pinned !== undefined && (pinned.role === "owner" || pinned.role === "editor");
}

/**
 * May this turn use the built-in model? Counts the turn as one call when it may,
 * so the cap is enforced before anything is spent rather than after.
 */
export const startBuiltinTurn = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.union(v.string(), v.null()),
    /** Set by the gateway's Try it route only; see the file's head. */
    tryIt: v.optional(v.boolean()),
  },
  returns: v.union(
    v.null(),
    v.object({ allowed: v.literal(true), remaining: v.number() }),
    v.object({ allowed: v.literal(false), reason: refusalValidator }),
  ),
  handler: async (ctx, args) => {
    const charged = await chargedWorkspace(ctx, args.hashedAccessToken, args.expectedWorkspaceId, args.tryIt === true);
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
    tryIt: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const charged = await chargedWorkspace(ctx, args.hashedAccessToken, args.expectedWorkspaceId, args.tryIt === true);
    if (charged === null || "refused" in charged) return false;
    await recordTurn(ctx, BUILTIN_FEATURE, charged.workspaceId, args, GLM_MODEL, Date.now());
    return true;
  },
});
