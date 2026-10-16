/**
 * Opening one page of the path-to-id copy for the gateway's mover
 * (`apps/mcp/src/moves/mover.js`, kinds `idCopy` and `idCheck`).
 *
 * The copy pass mints a ticket for the items it wants copied or checked
 * (`lib/storageMover.ts`); the mover spends it at `/gateway/mover/open`, which
 * lands in `managedProvisioning.openMoverPage` and, for an id ticket, here.
 *
 * A copy page opens only while its run is still the current one and not
 * paused, and every item still names the same live file, at the same etag,
 * under the same id key. Anything else is a page somebody already moved past,
 * and opens nothing (`null`, which the mover answers as `STALE`). Only then is
 * the bucket opened, for those items.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { GatewayCredential } from "../storage/shapes";
import { ID_BYTE_BUDGET, ID_LANES, type NoteIdItem } from "../nodes/noteIds";

export type NoteIdTicket = { idRunId: number; idItems: NoteIdItem[] };

export type NoteIdMoverPage = {
  kind: "idCopy" | "idCheck";
  workspaceId: string;
  source: GatewayCredential & { workspaceId: string };
  items: NoteIdItem[];
  limits: { lanes: number; byteBudget: number };
};

export async function openNoteIdPage(
  ctx: ActionCtx,
  ticket: { workspaceId: Id<"workspaces">; phase: string; runId: number; items: NoteIdItem[] },
): Promise<NoteIdMoverPage | null> {
  const kind = ticket.phase === "id_copy" ? "idCopy" : ticket.phase === "id_check" ? "idCheck" : null;
  if (kind === null || ticket.items.length === 0) return null;
  const current: boolean = await ctx.runQuery(internal.functions.noteIdsCopy.pageIsCurrent, {
    workspaceId: ticket.workspaceId,
    runId: ticket.runId,
    phase: ticket.phase,
    items: ticket.items,
  });
  if (!current) return null;
  const credential: GatewayCredential | null = await ctx.runAction(internal.functions.storage.getBindingForGateway, {
    workspaceId: ticket.workspaceId,
  });
  if (credential === null) throw new Error("SOURCE_UNAVAILABLE");
  return {
    kind,
    workspaceId: String(ticket.workspaceId),
    source: { ...credential, workspaceId: String(ticket.workspaceId) },
    items: ticket.items,
    limits: { lanes: ID_LANES, byteBudget: ID_BYTE_BUDGET },
  };
}
