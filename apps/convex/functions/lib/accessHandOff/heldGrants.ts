/**
 * Whose object holds an AI client's connection (decided by the owner,
 * 2026-11-01: `docs/decisions/identity-and-access/access-in-objects.md`).
 * Once a person's access is switched (`personAccess: object`), their person
 * object is the authority for their connections and Convex is written behind
 * it, so the gateway makes, rotates and revokes those connections there
 * (`apps/mcp/src/oauth/objectGrants.js`). Texting clients and Tex group chats'
 * grants are never held by an object (`record.ts` `CONVEX_ONLY_CLIENTS`).
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { accessHomeOf, type AccessHome } from "../accessObjects/home";
import { personalWorkspaceOf } from "../faces/people";
import { CONVEX_ONLY_CLIENTS } from "./record";

/** A person's personal workspace and where their access is read from, or `null` without one. */
export async function personHome(ctx: QueryCtx, userId: Id<"users">): Promise<{ personalWorkspaceId: Id<"workspaces">; access: AccessHome } | null> {
  const personal = await personalWorkspaceOf(ctx, userId);
  if (personal === null) return null;
  return { personalWorkspaceId: personal._id, access: await accessHomeOf(ctx.db, personal._id, "person") };
}

/** The personal workspace whose object holds this grant, or `null` while Convex still decides it. */
export async function objectHolding(ctx: QueryCtx, grant: Doc<"oauthGrants">): Promise<Id<"workspaces"> | null> {
  if (grant.texGroup !== undefined || CONVEX_ONLY_CLIENTS.has(grant.clientId)) return null;
  const home = await personHome(ctx, grant.userId);
  return home !== null && home.access === "object" ? home.personalWorkspaceId : null;
}
