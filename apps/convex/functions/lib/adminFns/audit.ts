/**
 * The staff console's own audit trail.
 *
 * Split out of `functions/admin.ts` — see that file's header for the
 * credential-boundary rule this whole module exists under.
 */

import type { MutationCtx } from "../../../_generated/server";
import type { AdminActor } from "../admin";

/** Admin acts worth a trail. A closed set, like the usage metrics. */
export const ADMIN_ACTIONS = [
  "secret.set",
  "secret.updated",
  "secret.deleted",
] as const;

export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export async function recordAdminAudit(
  ctx: MutationCtx,
  actor: AdminActor,
  action: AdminAction,
  subject: string,
  details?: Record<string, string | number | boolean | null>,
): Promise<void> {
  await ctx.db.insert("adminAuditEvents", {
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action,
    subject,
    at: Date.now(),
    details,
  });
}
