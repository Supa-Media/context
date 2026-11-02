/**
 * Display profiles for people a workspace object already admitted (thread F of
 * access-in-objects, decided by the owner, 2026-11-01;
 * `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * Accounts (name, email) stay in the control plane; who belongs to a workspace
 * lives in its object. So the members screen's names come from here, asked by
 * the workspace object for its own member list after it has checked the reader
 * is a member. This query never decides membership and has no caller but the
 * gateway's door (`/gateway/access/profiles`, behind the gateway's secret).
 *
 * The handle is the person's personal workspace's slug, read from the
 * `personalWorkspaceId` the object holds on the member row, so it does not
 * depend on Convex's membership rows, which are dropped after the switch.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";

/** The members screen shows at most this many; the object never asks for more. */
export const MAX_PROFILES = 200;

export const profilesFor = internalQuery({
  args: { people: v.array(v.object({ userId: v.string(), personalWorkspaceId: v.optional(v.string()) })) },
  handler: async (ctx, { people }) => {
    const profiles: { userId: string; name?: string; email?: string; handle?: string }[] = [];
    const seen = new Set<string>();
    for (const person of people.slice(0, MAX_PROFILES)) {
      if (seen.has(person.userId)) continue;
      seen.add(person.userId);
      const userId = ctx.db.normalizeId("users", person.userId);
      if (userId === null) continue;
      const user = await ctx.db.get(userId);
      if (user === null) continue;
      const workspaceId = person.personalWorkspaceId === undefined ? null : ctx.db.normalizeId("workspaces", person.personalWorkspaceId);
      const workspace = workspaceId === null ? null : await ctx.db.get(workspaceId as Id<"workspaces">);
      const handle = workspace !== null && workspace.kind === "personal" ? workspace.slug : undefined;
      profiles.push({
        userId: person.userId,
        ...(typeof user.name === "string" ? { name: user.name } : {}),
        ...(typeof user.email === "string" ? { email: user.email } : {}),
        ...(handle === undefined ? {} : { handle }),
      });
    }
    return profiles;
  },
});
