/**
 * The global name namespace — public surface.
 *
 * Usernames and workspace slugs are claimed out of the same pool, so this is
 * the one place that answers "can I have `@atlas`?" for either.
 */

import { v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { checkAvailability } from "./lib/nameClaims";
import {
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  describeRejection,
  validateName,
} from "./lib/names";

/**
 * Is this name free?
 *
 * Requires authentication. A namespace check is unavoidably an existence
 * oracle for names — that is what it is for — but there is no reason to hand
 * an unauthenticated scraper a fast, free endpoint for enumerating who is on
 * the platform. Sign-in comes before name selection in the product flow
 * anyway, so this costs nothing.
 *
 * The response carries a reason code and no information about the holder of a
 * taken name.
 *
 * ## It is not rate limited, and cannot be
 *
 * This is a Convex `query`, and a query cannot write — so it cannot maintain a
 * counter, and no table-based limiter can throttle it. Rather than pretend
 * otherwise, the limit lives where it bites: `createWorkspace` caps how many
 * names one account may ever hold and how fast it may take them. Probing tells
 * an attacker which names are free; the cap is what stops them converting that
 * list into claims. If this endpoint ever needs real throttling, it needs an
 * infrastructure-level limiter, not a rewrite into a mutation — making it a
 * mutation would cost the reactive, cacheable behavior the name picker depends
 * on and would still be trivially parallelizable.
 */
export const checkNameAvailable = query({
  args: { name: v.string() },
  returns: v.object({
    available: v.boolean(),
    normalized: v.string(),
    reason: v.optional(v.string()),
    message: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    await requireAuthId(ctx);

    const availability = await checkAvailability(ctx, args.name);
    if (availability.available) {
      return { available: true, normalized: availability.normalized };
    }
    return {
      available: false,
      normalized: availability.normalized,
      reason: availability.reason,
      message: describeRejection(availability.reason),
    };
  },
});

/**
 * Validate a name's *shape* without touching the database.
 *
 * Lets a client give per-keystroke feedback (charset, length, reserved) without
 * a round trip per character, which also keeps the availability endpoint from
 * being hammered. Never treat an `ok: true` here as "the name is yours" —
 * only `createWorkspace` decides that, transactionally.
 */
export const validateNameShape = query({
  args: { name: v.string() },
  returns: v.object({
    ok: v.boolean(),
    normalized: v.string(),
    reason: v.optional(v.string()),
    message: v.optional(v.string()),
    minLength: v.number(),
    maxLength: v.number(),
  }),
  handler: async (_ctx, args) => {
    const result = validateName(args.name);
    return {
      ok: result.ok,
      normalized: result.normalized,
      reason: result.ok ? undefined : result.reason,
      message: result.ok ? undefined : describeRejection(result.reason),
      minLength: NAME_MIN_LENGTH,
      maxLength: NAME_MAX_LENGTH,
    };
  },
});

/**
 * Resolve `@name` to a workspace the caller can actually reach.
 *
 * Cross-context paths are addressed `@name/1-projects/foo.md`, so the gateway
 * needs a way to turn a name into a workspace id. It resolves to `null` for a
 * name that does not exist AND for one the caller is not a member of — same
 * answer either way, so this cannot be used to enumerate the namespace's
 * contents. (Availability checking is a separate, deliberate oracle above; it
 * returns "taken" but never an id.)
 */
export const resolveMyName = query({
  args: { name: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      slug: v.string(),
      displayName: v.string(),
      role: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    const validation = validateName(args.name);
    if (!validation.ok) return null;

    const claim = await ctx.db
      .query("names")
      .withIndex("by_name", (q) => q.eq("name", validation.normalized))
      .unique();
    if (claim === null || claim.workspaceId === undefined) return null;

    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", claim.workspaceId!).eq("userId", userId),
      )
      .unique();
    if (membership === null) return null;

    const workspace = await ctx.db.get(claim.workspaceId);
    if (workspace === null) return null;

    return {
      workspaceId: workspace._id,
      slug: workspace.slug,
      displayName: workspace.displayName,
      role: membership.role,
    };
  },
});
