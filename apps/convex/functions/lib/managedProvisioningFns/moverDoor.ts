/**
 * The mover's door (`lib/storageMover.ts`): spend one page's ticket and open
 * the buckets for it. Everything comes off the ticket and the row, never the
 * request; a ticket for a page already passed opens nothing.
 *
 * `managedProvisioning.openMoverPage` is the Convex function; it delegates here
 * (moved out unchanged to keep that file under its size limit).
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { decryptSecret, requireKeyset } from "../crypto";
import { managedEncryptionOption } from "../managedEncryptionFns/storeOption";
import { openWalkPage, type WalkMoverPage, type WalkTicket } from "../managedEncryptionFns/walkMover";
import { type ContextMoveMoverPage, type ContextMoveTicket, openContextMovePage } from "../contextMoveMover";
import { type NoteIdMoverPage, type NoteIdTicket, openNoteIdPage } from "../noteIds/mover";
import { type CleanupMoverPage, openCleanupTicket } from "../cleanup/mover";
import { outOfManagedBucket } from "./direction";
import { MOVER_PAGE_LIMITS, migrationPageFor } from "./migrationRun";

type GatewayCredential = Parameters<typeof migrationPageFor>[2] | null;
type MoverTicketJobs = Partial<NoteIdTicket> & {
  walkRunId?: number;
  migrationId?: Id<"managedStorageMigrations">;
  contextMoveId?: Id<"contextMoves">;
  objects?: ContextMoveTicket["objects"];
  cleanupRunId?: number;
  cleanupKeys?: string[];
};

export type MoverPage = ReturnType<typeof migrationPageFor> | WalkMoverPage | ContextMoveMoverPage | NoteIdMoverPage | CleanupMoverPage;

export async function openMoverPageHandler(ctx: ActionCtx, args: { hashedTicket: string }): Promise<MoverPage | null> {
  const ticket: (Omit<WalkTicket, "walkRunId"> & MoverTicketJobs) | null = await ctx.runMutation(internal.functions.storageMover.claimPage, {
    hashedTicket: args.hashedTicket,
    now: Date.now(),
  });
  if (ticket === null) return null;
  if (ticket.walkRunId !== undefined) return await openWalkPage(ctx, { ...ticket, walkRunId: ticket.walkRunId });
  if (ticket.contextMoveId !== undefined) return await openContextMovePage(ctx, { ...ticket, contextMoveId: ticket.contextMoveId, objects: ticket.objects ?? [] });
  if (ticket.idRunId !== undefined) return await openNoteIdPage(ctx, { workspaceId: ticket.workspaceId, phase: ticket.phase, runId: ticket.idRunId, items: ticket.idItems ?? [] });
  if (ticket.cleanupRunId !== undefined) return await openCleanupTicket(ctx, { ...ticket, cleanupRunId: ticket.cleanupRunId });
  const migration: Doc<"managedStorageMigrations"> | null = await ctx.runQuery(internal.functions.managedProvisioning.migrationForCopy, {
    workspaceId: ticket.workspaceId,
  });
  if (
    migration === null ||
    migration._id !== ticket.migrationId ||
    migration.status !== "copying" ||
    migration.readyToCutover === true ||
    migration.phase !== ticket.phase ||
    migration.cursor !== ticket.expectedCursor
  ) {
    return null;
  }
  const sourceCredential: GatewayCredential = await ctx.runAction(internal.functions.storage.getBindingForGateway, {
    workspaceId: ticket.workspaceId,
  });
  if (sourceCredential === null) throw new Error("SOURCE_UNAVAILABLE");
  const secretAccessKey = await decryptSecret(migration.encryptedTargetSecretAccessKey, requireKeyset(), {
    workspaceId: ticket.workspaceId,
  });
  const sourceEncryption = outOfManagedBucket(migration) ? await managedEncryptionOption(ctx, ticket.workspaceId) : null;
  return migrationPageFor(ticket.workspaceId, migration, sourceCredential, secretAccessKey, sourceEncryption, MOVER_PAGE_LIMITS);
}
