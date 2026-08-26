/**
 * Workspaces — the unit that owns a context.
 *
 * A personal context and a shared project context are the same row with
 * different membership. Nothing here special-cases "personal", and nothing
 * should: the moment a second person is added, an app that modelled personal
 * contexts separately needs a migration instead of an insert.
 */

import { ConvexError, v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { claimName, checkAvailability, nameRejectionError } from "./lib/nameClaims";
import { requireWorkspaceAccess } from "./lib/workspaceAuth";

const MAX_DISPLAY_NAME_LENGTH = 80;

const workspaceSummary = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.string(),
  displayName: v.string(),
  kind: v.string(),
  structureTemplate: v.string(),
  role: v.string(),
  joinedAt: v.number(),
  createdAt: v.number(),
});

/**
 * Create a workspace, claim its name, and make the creator its owner —
 * atomically.
 *
 * All three writes happen in one Convex mutation, which is a serializable
 * transaction. If the name claim loses a race, or any later step throws, the
 * whole thing rolls back: no orphan workspace with no name, no claimed name
 * pointing at nothing, no workspace with no owner. That last one matters most
 * — a workspace whose only owner failed to be written is a context nobody can
 * ever administer or delete.
 *
 * Do not split this into an action that orchestrates several mutations. The
 * atomicity is the feature.
 */
export const createWorkspace = mutation({
  args: {
    slug: v.string(),
    displayName: v.string(),
    kind: v.union(v.literal("personal"), v.literal("shared")),
    structureTemplate: v.optional(
      v.union(v.literal("para"), v.literal("custom")),
    ),
  },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    slug: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

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

    return { workspaceId, slug: availability.normalized };
  },
});

/**
 * Every workspace the caller can reach, with their role in each.
 *
 * Driven off `workspaceMembers.by_user`, never off a scan of `workspaces` —
 * so the query is structurally incapable of returning a workspace the caller
 * is not in, rather than relying on a filter someone might later "optimize"
 * away.
 *
 * An authenticated session resolves to a *set* of contexts even while that set
 * has exactly one element today. Clients must not assume `[0]`.
 */
export const listMyWorkspaces = query({
  args: {},
  returns: v.array(workspaceSummary),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const summaries = [];
    for (const membership of memberships) {
      const workspace = await ctx.db.get(membership.workspaceId);
      if (workspace === null) continue;
      summaries.push({
        workspaceId: workspace._id,
        slug: workspace.slug,
        displayName: workspace.displayName,
        kind: workspace.kind,
        structureTemplate: workspace.structureTemplate,
        role: membership.role,
        joinedAt: membership.joinedAt,
        createdAt: workspace.createdAt,
      });
    }
    return summaries.sort((a, b) => a.createdAt - b.createdAt);
  },
});

/**
 * One workspace, if the caller is a member of it.
 *
 * A non-member gets `WORKSPACE_NOT_FOUND` — byte-identical to the error for an
 * id that never existed. See `lib/workspaceAuth.ts` for why that matters.
 */
export const getWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    slug: v.string(),
    displayName: v.string(),
    kind: v.string(),
    structureTemplate: v.string(),
    role: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    memberCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const { workspace, membership } = await requireWorkspaceAccess(
      ctx,
      args.workspaceId,
      userId,
    );

    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .collect();

    return {
      workspaceId: workspace._id,
      slug: workspace.slug,
      displayName: workspace.displayName,
      kind: workspace.kind,
      structureTemplate: workspace.structureTemplate,
      role: membership.role,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      memberCount: members.length,
    };
  },
});

/**
 * Who else is in this context.
 *
 * Members of a shared context can see each other — that is what makes `team`
 * visibility meaningful ("named people the owner granted access to", not
 * anonymous). Emails are included because a member needs to know *who* they
 * are sharing their notes with; that is exactly the information the sharing
 * decision turns on.
 */
export const listMembers = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(
    v.object({
      userId: v.id("users"),
      role: v.string(),
      email: v.optional(v.string()),
      name: v.optional(v.string()),
      joinedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceAccess(ctx, args.workspaceId, userId);

    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    const rows = [];
    for (const member of members) {
      const user = await ctx.db.get(member.userId);
      rows.push({
        userId: member.userId,
        role: member.role,
        email: user?.email,
        name: user?.name,
        joinedAt: member.joinedAt,
      });
    }
    return rows.sort((a, b) => a.joinedAt - b.joinedAt);
  },
});
