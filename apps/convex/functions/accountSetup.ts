import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { createWorkspaceHandler } from "./lib/workspaces/create";
import { MAX_DISPLAY_NAME_LENGTH } from "./lib/workspaces/constants";
import {
  availableSlug,
  joinedThroughDomain,
  ownedPersonalWorkspace,
  suggestedNameFor,
} from "./lib/accountSetup";

/**
 * Finishing account setup (Dev2, 2026-10-16).
 *
 * A person who signed up through a shared workspace's email domain has no
 * workspace of their own. The app asks once, after sign-up, for their name
 * and makes them a personal workspace from it, named the same. Everything
 * here reads or writes the signed-in person's own account only.
 */

const MIN_NAME = 1;
const MAX_NAME = MAX_DISPLAY_NAME_LENGTH;

/** What the setup screen needs: whether to ask, the sign-in email, and a name to offer. */
export const mySetup = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      needsSetup: v.boolean(),
      email: v.union(v.string(), v.null()),
      suggestedName: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (user === null) return null;
    const needsSetup =
      (await joinedThroughDomain(ctx, userId)) && (await ownedPersonalWorkspace(ctx, userId)) === null;
    return {
      needsSetup,
      email: user.email ?? null,
      suggestedName: suggestedNameFor(user.name, user.email ?? null),
    };
  },
});

/**
 * Name the person and make their personal workspace. Idempotent: a person who
 * already owns one gets its slug back and nothing is created. The name is
 * trimmed and must be 1 to 80 characters.
 */
export const finishSetup = mutation({
  args: { name: v.string() },
  returns: v.object({ slug: v.string() }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const name = args.name.trim();
    if (name.length < MIN_NAME || name.length > MAX_NAME) {
      throw new ConvexError({
        code: "INVALID",
        message: `A name is 1 to ${MAX_NAME} characters.`,
      });
    }
    await ctx.db.patch(userId, { name });
    const existing = await ownedPersonalWorkspace(ctx, userId);
    if (existing !== null) return { slug: existing.slug };
    const slug = await availableSlug(ctx, name);
    const created = await createWorkspaceHandler(ctx, { slug, displayName: name, kind: "personal" });
    return { slug: created.slug };
  },
});
