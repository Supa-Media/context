/**
 * Opening one page of the encryption walk for the gateway's mover.
 *
 * The walk's action mints a ticket for the page it is on (its run, phase and
 * cursor) and hands it to the mover (`lib/storageMover.ts`); the mover spends
 * it at `/gateway/mover/open`, which lands in
 * `managedProvisioning.openMoverPage` and, for a walk ticket, here.
 *
 * A page is opened only while the walk is still exactly where the ticket says:
 * the same run (a pause, a retry or a restart bumps it), the same phase and
 * the same cursor, and nothing that `walkPlan` would stop for. Anything else
 * is a page somebody already moved past, and opens nothing. Only then are the
 * workspace's data key and its bucket opened, for this one page.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { GatewayCredential } from "../storage/shapes";
import { MOVER_WALK_BYTE_BUDGET, MOVER_WALK_LANES, SEAL_PAGE, bucketSettling, walkPhase, type WalkPlan } from "./walk";

export type WalkTicket = {
  workspaceId: Id<"workspaces">;
  walkRunId: number;
  phase: string;
  expectedCursor?: string;
};

export type WalkMoverPage = {
  kind: "walk";
  workspaceId: string;
  phase: "seal" | "check" | "unseal" | "confirm";
  cursor: string | null;
  source: GatewayCredential & { workspaceId: string };
  dataKey: { current: string; keys: Record<string, string> };
  limits: { pageSize: number; lanes: number; byteBudget: number };
};

export async function openWalkPage(ctx: ActionCtx, ticket: WalkTicket): Promise<WalkMoverPage | null> {
  const plan: WalkPlan | null = await ctx.runQuery(internal.functions.managedEncryption.walkPlan, {
    workspaceId: ticket.workspaceId,
    runId: ticket.walkRunId,
  });
  if (plan === null || plan.state === "waiting" || bucketSettling(plan, Date.now())) return null;
  const phase = walkPhase(plan);
  if (phase === "count" || phase !== ticket.phase || plan.cursor !== ticket.expectedCursor) return null;
  const dataKey: { current: string; keys: Record<string, string> } | null = await ctx.runAction(
    internal.functions.encryptionKeys.openWorkspaceDataKey,
    // The way back never mints a key, as in the walk's own run.
    { workspaceId: ticket.workspaceId, create: plan.state !== "decrypting" },
  );
  const credential: GatewayCredential | null = await ctx.runAction(internal.functions.storage.getBindingForGateway, {
    workspaceId: ticket.workspaceId,
  });
  if (dataKey === null || credential === null) throw new Error("KEY_UNAVAILABLE");
  return {
    kind: "walk",
    workspaceId: String(ticket.workspaceId),
    phase,
    cursor: plan.cursor ?? null,
    source: { ...credential, workspaceId: String(ticket.workspaceId) },
    dataKey,
    limits: { pageSize: SEAL_PAGE, lanes: MOVER_WALK_LANES, byteBudget: MOVER_WALK_BYTE_BUDGET },
  };
}
