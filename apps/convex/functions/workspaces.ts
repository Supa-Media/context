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
import { recordAudit } from "./lib/audit";
import { claimName, checkAvailability, nameRejectionError } from "./lib/nameClaims";
import { seedIngestionSettings } from "./lib/ingestionStore";
import { consumeRateLimit } from "./lib/rateLimit";
import {
  getMembership,
  requireWorkspaceAccess,
  requireWorkspaceRole,
} from "./lib/workspaceAuth";

const MAX_DISPLAY_NAME_LENGTH = 80;

/**
 * How many contexts one account may own, and how fast it may create them.
 *
 * ## Why there is a limit at all
 *
 * Creating a workspace claims a name out of a single global namespace that has
 * no release, rename, or delete path — a claim is permanent. The short end of
 * `[a-z0-9-]{2,32}` is small (~1.3k two-character names, ~46k three-character
 * ones), so an unlimited account can exhaust the memorable part of the
 * namespace in minutes and keep it forever. Names are also the addressing
 * scheme (`@name/1-projects/foo.md`) and a future subdomain, which makes a
 * squatted name an impersonation surface as well as a denial of one.
 *
 * ## The numbers, and what they are a guess at
 *
 * These are a **product decision made here rather than left implicit**, and
 * they are deliberately loose enough that no honest user meets them:
 *
 *  - `MAX_WORKSPACES_PER_USER` — one personal context plus a healthy number of
 *    shared ones. Someone genuinely running more than this is a case to look
 *    at, and raising a constant is a one-line change; un-squatting a namespace
 *    is not.
 *  - `WORKSPACE_CREATE_*` — a burst limit, aimed at scripted claiming rather
 *    than at people. Creating ten contexts in an hour by hand does not happen.
 *
 * Ownership is counted from `workspaceMembers`, so this bounds contexts a user
 * *owns*, not contexts they were invited into: being added to a colleague's
 * shared context must never use up your own allowance.
 */
const MAX_WORKSPACES_PER_USER = 10;
const WORKSPACE_CREATE_LIMIT = 5;
const WORKSPACE_CREATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Caps on how many rows one response carries.
 *
 * An unbounded `.collect()` reads however many rows exist, which is a cost set
 * by whoever can insert them. These bound the read; if a real workspace ever
 * approaches one, it needs pagination rather than a bigger constant.
 */
const MAX_MEMBERS_RETURNED = 200;
const MAX_WORKSPACES_RETURNED = 100;

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

    // How many contexts this account already owns. Read before the name is
    // even looked at: hitting the cap must not depend on what you asked for.
    const owned = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_WORKSPACES_PER_USER + 1);
    if (owned.filter((m) => m.role === "owner").length >= MAX_WORKSPACES_PER_USER) {
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
    await consumeRateLimit(ctx, {
      key: `workspace.create:${userId}`,
      limit: WORKSPACE_CREATE_LIMIT,
      windowMs: WORKSPACE_CREATE_WINDOW_MS,
    });

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

    // The capture address `<slug>@context.lc` becomes live the moment the slug
    // is claimed, so the policy governing it has to exist by the time this
    // transaction commits — a workspace that is addressable but has no stored
    // policy is a window, however brief. Seeded closed: the owner's own account
    // email and nobody else. See `lib/ingestionStore.ts`.
    await seedIngestionSettings(ctx, { workspaceId, ownerUserId: userId, now });

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
      .take(MAX_WORKSPACES_RETURNED);

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

    // Bounded, so `memberCount` saturates at the cap rather than paying for an
    // unbounded read. A context with more members than this does not exist,
    // and if one ever does the number wants pagination, not a full scan.
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .take(MAX_MEMBERS_RETURNED);

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
      /**
       * Whether this row is the caller, so an interface can say "you" instead
       * of comparing ids it would otherwise have to be told. Same reason
       * `listGrants` carries `isMine`.
       */
      isMe: v.boolean(),
      joinedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceAccess(ctx, args.workspaceId, userId);

    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_MEMBERS_RETURNED);

    const rows = [];
    for (const member of members) {
      const user = await ctx.db.get(member.userId);
      rows.push({
        userId: member.userId,
        role: member.role,
        email: user?.email,
        name: user?.name,
        isMe: member.userId === userId,
        joinedAt: member.joinedAt,
      });
    }
    return rows.sort((a, b) => a.joinedAt - b.joinedAt);
  },
});

/**
 * The refusal for a member this workspace does not have.
 *
 * Safe to be distinct from every other error here, and distinct on purpose:
 * only an `owner` reaches this line, and an owner can already enumerate their
 * own members with `listMembers`. There is nothing for the refusal to disclose,
 * and "that person is not in this context" is the only form of it they can act
 * on.
 */
function memberNotFound(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "MEMBER_NOT_FOUND",
    message: "That person is not a member of this context.",
  });
}

/**
 * Remove somebody from a context. Owner-only.
 *
 * ## An owner cannot be removed, including by themselves
 *
 * Every workspace has exactly one `owner` — `createWorkspace` writes it and
 * nothing else ever mints one, because `inviteMember`'s role validator excludes
 * `owner` and `setMemberRole`'s does too. Removing that row would leave a
 * context with a storage credential, an audit trail and possibly other members,
 * and nobody able to administer, rebind or wind it down: unrecoverable, from a
 * single click. Handing a context to somebody else is a separate, deliberate
 * act and is not built, so for now the answer is simply no.
 *
 * ## Already-issued AI-client grants stop working immediately
 *
 * Nothing here touches `oauthGrants`, and that is the design rather than an
 * omission. Every path that turns a token into authority — the access-token
 * resolution in `functions/controlPlane.ts`, the refresh rotation beside it,
 * and `resolveGrantByRefreshToken` in `functions/grants.ts` — re-reads
 * membership on every single call, so deleting this one row cuts off every
 * client the person had connected, in the same instant, without a sweep or a
 * revocation list to get wrong. Marking the grants revoked here as well would
 * add a second mechanism that can silently become the one people rely on;
 * `__tests__/membership.test.ts` proves the first one holds.
 *
 * Removing somebody who is not a member is `{ removed: false }`, not an error:
 * the caller is an owner, so it is idempotent rather than informative.
 */
export const removeMember = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
  },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    const actorId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

    const target = await getMembership(ctx, args.workspaceId, args.userId);
    if (target === null) return { removed: false };

    if (target.role === "owner") {
      throw new ConvexError({
        code: "CANNOT_REMOVE_OWNER",
        message:
          "A context's owner cannot be removed. Transferring ownership is a separate step, and is not built yet.",
      });
    }

    await ctx.db.delete(target._id);

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: actorId,
      action: "member.removed",
      details: { targetUserId: args.userId, previousRole: target.role },
    });

    return { removed: true };
  },
});

/**
 * Change what somebody may do in a context. Owner-only.
 *
 * `editor` and `member` only — the same closed set `inviteMember` offers, for
 * the same reason. A promotion to `owner` would be an ownership transfer with
 * no confirmation and no way back, and a demotion *from* `owner` is the
 * unrecoverable case `removeMember` describes.
 *
 * Setting the role somebody already has writes nothing and records nothing. An
 * audit trail that logs a change that did not happen makes the trail harder to
 * read, not easier.
 */
export const setMemberRole = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(v.literal("editor"), v.literal("member")),
  },
  returns: v.object({ role: v.string() }),
  handler: async (ctx, args) => {
    const actorId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

    const target = await getMembership(ctx, args.workspaceId, args.userId);
    if (target === null) throw memberNotFound();

    if (target.role === "owner") {
      throw new ConvexError({
        code: "CANNOT_CHANGE_OWNER_ROLE",
        message:
          "A context's owner keeps the owner role. Transferring ownership is a separate step, and is not built yet.",
      });
    }

    if (target.role === args.role) return { role: target.role };

    await ctx.db.patch(target._id, { role: args.role });

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: actorId,
      action: "member.role_changed",
      details: {
        targetUserId: args.userId,
        previousRole: target.role,
        role: args.role,
      },
    });

    return { role: args.role };
  },
});
