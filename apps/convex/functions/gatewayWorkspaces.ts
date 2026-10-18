/**
 * Setting a workspace up through an agent: the internal halves of
 * `POST /gateway/workspaces/*` (`lib/gatewayRoutes/workspaces.ts`).
 *
 * The owner asked on 2026-10-17 that what is UI-only about Context itself be
 * doable through the MCP, so the texting assistant needs a browser only for a
 * third party's sign-in. Every function here is INTERNAL and takes the acting
 * person as `actorUserId`, which the route read off a live grant; none of them
 * re-implements a rule the app's own mutation applies. They call the same
 * handlers (`createWorkspaceHandler`, `applyStructureHandler`,
 * `startFreeManagedHandler`) with that person, so a name, a cap, a rate limit
 * or an owner check cannot differ between the app and an agent.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { startFreeManagedHandler } from "./lib/billing/freeManaged";
import { deploymentOffersFreeManaged } from "./lib/billing/plan";
import { checkAvailability } from "./lib/nameClaims";
import { describeRejection } from "./lib/names";
import { createWorkspaceHandler } from "./lib/workspaces/create";
import { applyStructureHandler } from "./lib/workspaces/structure";

/** Whether a name is free to claim, in the words the app's name field uses. */
export const checkName = internalQuery({
  args: { name: v.string() },
  returns: v.object({ available: v.boolean(), normalized: v.string(), message: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const availability = await checkAvailability(ctx, args.name);
    if (availability.available) return { available: true, normalized: availability.normalized };
    return {
      available: false,
      normalized: availability.normalized,
      message: describeRejection(availability.reason),
    };
  },
});

/**
 * A shared workspace owned by `actorUserId` alone, and somewhere to keep its
 * notes.
 *
 * The workspace is the app's own `createWorkspace` (one transaction: the row,
 * the name claim, the owner membership). Storage is the answer the app's
 * workspace flow offers first where this deployment can make it: the free
 * bucket Context runs, started in the same transaction so a refusal rolls the
 * workspace back rather than leaving one with no way to hold a note. Where it
 * cannot, the workspace is still made and `storage` says `none`; the person
 * connects a bucket of their own in the app.
 *
 * Nothing here widens who sees anything: the only member is the person who
 * asked, and the bucket starts empty.
 */
export const createShared = internalMutation({
  args: {
    actorUserId: v.id("users"),
    actorClientId: v.string(),
    slug: v.string(),
    displayName: v.string(),
  },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    slug: v.string(),
    storage: v.union(v.literal("starting"), v.literal("none")),
  }),
  handler: async (ctx, args) => {
    const created = await createWorkspaceHandler(ctx, args.actorUserId, {
      slug: args.slug,
      displayName: args.displayName,
      kind: "shared",
    });
    const storage: "starting" | "none" = deploymentOffersFreeManaged() ? "starting" : "none";
    if (storage === "starting") await startFreeManagedHandler(ctx, args.actorUserId, created.workspaceId);
    // The app's create records nothing; an agent's says which client made it,
    // because "who made this workspace" is otherwise a question with no answer.
    await recordAudit(ctx, {
      workspaceId: created.workspaceId,
      actorUserId: args.actorUserId,
      actorClientId: args.actorClientId,
      action: "workspace.created",
      details: { kind: "shared", storage },
    });
    return { ...created, storage };
  },
});

/** `applyStructure`, as the person a grant resolved to. Owner-only there, as in the app. */
export const applyLayout = internalMutation({
  args: {
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    template: v.union(v.literal("para"), v.literal("custom")),
    folders: v.optional(v.array(v.object({ folder: v.string(), description: v.string() }))),
  },
  returns: v.object({ queued: v.boolean(), template: v.string(), folders: v.array(v.string()) }),
  handler: async (ctx, { actorUserId, ...args }) => await applyStructureHandler(ctx, actorUserId, args),
});
