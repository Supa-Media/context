/**
 * Claiming names out of the one global namespace.
 *
 * The database half of `./names.ts`. Kept separate so the rules (charset,
 * length, reserved words) stay pure and directly testable, while the part that
 * needs a transaction lives here.
 *
 * ## On the race
 *
 * Two people claiming `@atlas` at the same instant must resolve to exactly one
 * winner. This is a lookup-then-insert, which is only safe because Convex
 * mutations are serializable transactions: the losing mutation's read of
 * `names.by_name` is part of its read set, so when the winner commits first
 * the loser's transaction conflicts, re-runs, sees the winning row, and
 * rejects. There is no `UNIQUE` constraint to lean on, so *every* write to
 * `names` must go through `claimName` — an insert that skips the check would
 * silently create a duplicate that nothing downstream expects.
 */

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { describeRejection, validateName, type NameRejection } from "./names";

/** Look up a claim by its normalized name. */
export async function findName(
  ctx: QueryCtx,
  normalized: string,
): Promise<Doc<"names"> | null> {
  return await ctx.db
    .query("names")
    .withIndex("by_name", (q) => q.eq("name", normalized))
    .unique();
}

export type NameAvailability =
  | { available: true; normalized: string }
  | { available: false; normalized: string; reason: NameRejection };

/**
 * Whether a candidate name is well-formed, unreserved, and unclaimed.
 *
 * Returns only a yes/no plus a reason code. It deliberately does NOT reveal
 * what a taken name belongs to — "taken" is the same answer whether the holder
 * is a person or a workspace, and no id or display name comes back. That is
 * the irreducible amount of information any namespace must disclose in order
 * to be usable, and no more.
 */
export async function checkAvailability(
  ctx: QueryCtx,
  raw: string,
): Promise<NameAvailability> {
  const validation = validateName(raw);
  if (!validation.ok) {
    return {
      available: false,
      normalized: validation.normalized,
      reason: validation.reason,
    };
  }
  const existing = await findName(ctx, validation.normalized);
  if (existing !== null) {
    return {
      available: false,
      normalized: validation.normalized,
      reason: "taken",
    };
  }
  return { available: true, normalized: validation.normalized };
}

export function nameRejectionError(
  normalized: string,
  reason: NameRejection,
): ConvexError<Record<string, string>> {
  return new ConvexError({
    code: "NAME_UNAVAILABLE",
    reason,
    name: normalized,
    message: describeRejection(reason),
  });
}

type ClaimTarget =
  | { kind: "user"; userId: Id<"users"> }
  | { kind: "workspace"; workspaceId: Id<"workspaces"> };

/**
 * Claim a name for a user or a workspace, or throw.
 *
 * Callers run inside a mutation, so a throw rolls the whole transaction back —
 * which is what keeps `createWorkspace` from leaving a half-claimed name
 * behind when a later step fails. Do not "helpfully" catch this and continue.
 */
export async function claimName(
  ctx: MutationCtx,
  raw: string,
  claimedBy: Id<"users">,
  target: ClaimTarget,
): Promise<{ id: Id<"names">; normalized: string }> {
  const availability = await checkAvailability(ctx, raw);
  if (!availability.available) {
    throw nameRejectionError(availability.normalized, availability.reason);
  }

  const id = await ctx.db.insert("names", {
    name: availability.normalized,
    kind: target.kind,
    userId: target.kind === "user" ? target.userId : undefined,
    workspaceId: target.kind === "workspace" ? target.workspaceId : undefined,
    claimedBy,
    claimedAt: Date.now(),
  });

  return { id, normalized: availability.normalized };
}
