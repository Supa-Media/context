/**
 * Writing audit events.
 *
 * The in-transaction helper behind `functions/audit.ts`. Kept separate so a
 * mutation that already has a `MutationCtx` can record an event as part of the
 * same transaction — an audit row that commits independently of the thing it
 * describes is worse than no audit row, because it can claim something
 * happened that was rolled back.
 *
 * Two rules, both enforceable only by discipline:
 *  - `details` is a flat record of scalars. Never put note content in it, and
 *    never put a secret in it. The schema's validator makes nesting
 *    impossible, which stops the accidental `details: { body }` — it cannot
 *    stop a deliberate `details: { body: text }`.
 *  - `paths` are bucket-relative paths, which are metadata. A path can still
 *    be sensitive (`1-projects/acquisition-of-acme.md`), which is exactly why
 *    reading the audit trail is scoped to workspace members.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

export type AuditDetails = Record<string, string | number | boolean | null>;

export interface AuditInput {
  workspaceId: Id<"workspaces">;
  /** The acting identity. Not a scope string — "team" is useless once team is four people. */
  actorUserId?: Id<"users">;
  /** The OAuth client that acted, when one did. */
  actorClientId?: string;
  action: string;
  paths?: string[];
  details?: AuditDetails;
}

export async function recordAudit(
  ctx: MutationCtx,
  input: AuditInput,
): Promise<Id<"auditEvents">> {
  return await ctx.db.insert("auditEvents", {
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    actorClientId: input.actorClientId,
    action: input.action,
    paths: input.paths ?? [],
    at: Date.now(),
    details: input.details,
  });
}
