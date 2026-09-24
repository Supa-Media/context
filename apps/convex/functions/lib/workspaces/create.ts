/**
 * The handler for `workspaces.createWorkspace`.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row,
 * and see `createWorkspace`'s own doc comment there for why this is one
 * mutation rather than an action that orchestrates several.
 */

import { ConvexError } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { claimName, checkAvailability, nameRejectionError } from "../nameClaims";
import { seedIngestionSettings } from "../ingestionStore";
import { consumeRateLimit } from "../rateLimit";
import { isProductionTestAccount } from "../testAccount";
import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_WORKSPACES_PER_USER,
  WORKSPACE_CREATE_LIMIT,
  WORKSPACE_CREATE_WINDOW_MS,
} from "./constants";

export async function createWorkspaceHandler(
  ctx: MutationCtx,
  args: {
    slug: string;
    displayName: string;
    kind: "personal" | "shared";
    structureTemplate?: "para" | "custom";
  },
): Promise<{ workspaceId: Id<"workspaces">; slug: string }> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  const user = await ctx.db.get(userId);
  const isTestAccount = isProductionTestAccount(user);

  const displayName = args.displayName.trim();
  if (displayName.length === 0) {
    throw new ConvexError({
      code: "INVALID_DISPLAY_NAME",
      message: "A workspace needs a display name.",
    });
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ConvexError({
      code: "INVALID_DISPLAY_NAME",
      message: `Display names must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
    });
  }

  // How many contexts this account already owns. Read before the name is
  // even looked at: hitting the cap must not depend on what you asked for.
  const owned = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_WORKSPACES_PER_USER + 1);
  if (!isTestAccount && owned.filter((m) => m.role === "owner").length >= MAX_WORKSPACES_PER_USER) {
    throw new ConvexError({
      code: "WORKSPACE_LIMIT_REACHED",
      message: `You can own at most ${MAX_WORKSPACES_PER_USER} contexts.`,
      limit: MAX_WORKSPACES_PER_USER,
    });
  }

  // Counts commits, not attempts: this whole mutation is one transaction, so
  // a creation that goes on to fail rolls the increment back with it. That
  // is the right unit here — a failed claim takes nothing out of the
  // namespace — but see `lib/rateLimit.ts` for what it does not protect.
  if (!isTestAccount) {
    await consumeRateLimit(ctx, {
      key: `workspace.create:${userId}`,
      limit: WORKSPACE_CREATE_LIMIT,
      windowMs: WORKSPACE_CREATE_WINDOW_MS,
    });
  }

  // Check first so a bad slug fails before we write anything. `claimName`
  // re-checks inside the same transaction, which is what actually enforces
  // uniqueness; this pass only buys a clean early error.
  const availability = await checkAvailability(ctx, args.slug);
  if (!availability.available) {
    throw nameRejectionError(availability.normalized, availability.reason);
  }

  const now = Date.now();
  const workspaceId = await ctx.db.insert("workspaces", {
    slug: availability.normalized,
    displayName,
    createdBy: userId,
    kind: args.kind,
    structureTemplate: args.structureTemplate ?? "para",
    createdAt: now,
    updatedAt: now,
  });

  await claimName(ctx, availability.normalized, userId, {
    kind: "workspace",
    workspaceId,
  });

  await ctx.db.insert("workspaceMembers", {
    workspaceId,
    userId,
    role: "owner",
    joinedAt: now,
  });

  // A **personal** context's capture address `<slug>@context.lc` becomes live
  // the moment the slug is claimed, so the policy governing it has to exist by
  // the time this transaction commits — a context that is addressable but has
  // no stored policy is a window, however brief. Seeded closed: the owner's
  // own account email and nobody else.
  //
  // A shared context gets no row, because it has no capture address to govern.
  // Mail lands in a personal context and nowhere else; a shared context
  // receives a note only when a person moves one there. Read the header of
  // `lib/ingestionStore.ts` before changing this line — the absence of the row
  // is the feature, and `seedIngestionSettings` throws if called anyway.
  if (args.kind === "personal") {
    await seedIngestionSettings(ctx, { workspaceId, ownerUserId: userId, now });
  }

  return { workspaceId, slug: availability.normalized };
}
