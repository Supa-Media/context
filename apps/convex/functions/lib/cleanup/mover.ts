/**
 * The mover's door for a page of the old-copy cleanup (`apps/mcp/src/moves/
 * cleanupPage.js`): spend the ticket, check the page is still the one to do,
 * and open the bucket for it. `managedProvisioning.openMoverPage` calls this
 * for a cleanup ticket, as it does for the id copy's.
 *
 * A list page opens only while its run is current and, for a delete run, its
 * cursor is the one the page was handed out at. A delete page opens only the
 * keys that are still safe to delete when it is spent: each re-checked against
 * the rows (`rows.ts`, `deletableKeys`), so a key a live row started to read
 * after the page was planned is kept. Anything else opens nothing (`null`,
 * which the mover answers as `STALE`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { GatewayCredential } from "../storage/shapes";
import { CLEANUP_PAGE } from "./pass";

export interface CleanupTicket {
  workspaceId: Id<"workspaces">;
  phase: "cleanup_list" | "cleanup_delete";
  runId: number;
  /** A list page's cursor (`expectedCursor`); unused by a delete page. */
  cursor?: string;
  /** A delete page's keys, as the control plane planned them. */
  keys: string[];
}

export type CleanupMoverPage =
  | {
      kind: "cleanupList";
      workspaceId: string;
      source: GatewayCredential & { workspaceId: string };
      cursor?: string;
      limit: number;
    }
  | {
      kind: "cleanupDelete";
      workspaceId: string;
      source: GatewayCredential & { workspaceId: string };
      keys: string[];
    };

/** A spent ticket's cleanup job, as `openMoverPage` reads it: anything but the two cleanup phases opens nothing. */
export async function openCleanupTicket(
  ctx: ActionCtx,
  ticket: { workspaceId: Id<"workspaces">; phase: string; cleanupRunId: number; expectedCursor?: string; cleanupKeys?: string[] },
): Promise<CleanupMoverPage | null> {
  if (ticket.phase !== "cleanup_list" && ticket.phase !== "cleanup_delete") return null;
  return await openCleanupPage(ctx, {
    workspaceId: ticket.workspaceId,
    phase: ticket.phase,
    runId: ticket.cleanupRunId,
    cursor: ticket.expectedCursor,
    keys: ticket.cleanupKeys ?? [],
  });
}

export async function openCleanupPage(ctx: ActionCtx, ticket: CleanupTicket): Promise<CleanupMoverPage | null> {
  const { workspaceId } = ticket;
  if (ticket.phase === "cleanup_list") {
    const current: boolean = await ctx.runQuery(internal.functions.noteIdsCleanup.listCurrent, {
      workspaceId,
      runId: ticket.runId,
      ...(ticket.cursor === undefined ? {} : { cursor: ticket.cursor }),
    });
    if (!current) return null;
  }
  let keys: string[] = [];
  if (ticket.phase === "cleanup_delete") {
    // The re-check that matters: every key is read again against the rows, now, before the bucket is opened.
    const safe: string[] | null = await ctx.runQuery(internal.functions.noteIdsCleanup.deleteOpenKeys, {
      workspaceId,
      runId: ticket.runId,
      keys: ticket.keys,
    });
    if (safe === null) return null;
    keys = safe;
  }
  const credential: GatewayCredential | null = await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId });
  if (credential === null) throw new Error("SOURCE_UNAVAILABLE");
  const source = { ...credential, workspaceId: String(workspaceId) };
  if (ticket.phase === "cleanup_list") {
    return {
      kind: "cleanupList",
      workspaceId: String(workspaceId),
      source,
      ...(ticket.cursor === undefined ? {} : { cursor: ticket.cursor }),
      limit: CLEANUP_PAGE,
    };
  }
  return { kind: "cleanupDelete", workspaceId: String(workspaceId), source, keys };
}
