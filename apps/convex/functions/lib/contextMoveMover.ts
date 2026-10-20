/**
 * A move into another context, carried by the gateway's mover.
 *
 * The owner chose this on 2026-10-14 ("Two keys"): for one batch the mover
 * holds both contexts' storage keys, so the files go bucket to bucket inside
 * Cloudflare and never through this deployment. Without `STORAGE_MOVER_ORIGIN`
 * the move runs as it always has (`functions/contextMoves.ts`), each batch
 * read out of one bucket and written into the other here; that is the brake,
 * and what a self-hosted deployment gets.
 *
 * What stays here is everything a person could be exposed by, decided through
 * the credential barrier one store at a time as before:
 *
 *  1. **plan** the batch in the source, by name (`contextMovePlan`): the same
 *     listing, the same checks, and each file's tier there;
 *  2. **prepare** the destination (`contextMovePrepare`): the merge check on
 *     the first batch, the mover's own clearance there, and the narrowing
 *     exceptions written before anything lands;
 *  3. the mover **carries** exactly the planned files
 *     (`apps/mcp/src/moves/contextMovePage.js`), named by the ticket;
 *  4. each tree hears what **arrived** and what **left**, and the source's
 *     exceptions for what left are cleared (`contextMoveArrived`,
 *     `contextMoveForget`).
 *
 * A mover that does not answer is not the move's fault: the pass is tried
 * again shortly rather than failed. A queued move still settling in either
 * bucket around these paths holds the pass back the same way, since the mover
 * works on the buckets' own names and the tree may draw those files elsewhere
 * until it settles.
 */

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { CONTEXT_MOVE_SKIP_CAP } from "./fileOps";
import { managedEncryptionOption, type ManagedEncryptionOption } from "./managedEncryptionFns/storeOption";
import { MIGRATION_OBJECT_BYTE_CAP } from "./managedProvisioningFns/constants";
import type { GatewayCredential } from "./storage/shapes";
import { type ContextMoveFailureCode, runContextMoveBatchOnMover } from "./storageMover";

/** Files in flight at once, and the bytes they may hold: the Worker's connection and memory bounds. */
export const CONTEXT_MOVE_LANES = 6;
export const CONTEXT_MOVE_BYTE_BUDGET = 16 * 1024 * 1024;
/** How long a pass waits before trying again when the mover did not answer. */
export const CONTEXT_MOVE_RETRY_MS = 30 * 1000;
/**
 * Notes a move may find edited mid-move, and take back and carry again, before
 * it stops. An open editor saving while its note moves is the usual one: its
 * copy goes, the batch is listed again, and the latest text is what arrives.
 * The pause gives the edit a moment to settle before the next read.
 */
export const CONTEXT_MOVE_CONFLICT_RETRIES = 5;
export const CONTEXT_MOVE_CONFLICT_PAUSE_MS = 1_000;

type Skip = { path: string; reason: "encrypted" | "too_large" };
type Access = { scope: "private" | "team"; grantedNames: string[] };
type MoveRow = {
  sourceWorkspaceId: Id<"workspaces">;
  destinationWorkspaceId: Id<"workspaces">;
  from: string;
  to: string;
  status: "moving" | "complete" | "failed";
  movedObjects: number;
};

export type MoverPass = {
  movedObjects: number;
  movedBytes: number;
  remaining: boolean;
  /** Set when the pass ended the move. */
  failed?: string;
  /** Set when the pass should run again later rather than now. */
  retry?: boolean;
  /** Edits met mid-move that the pass took back and carried again. */
  conflicts?: number;
};

/** Words for a move that kept meeting edits, never a provider's text. */
export const CONFLICT_STOPPED =
  "A note changed while it was being moved, so the move stopped. Everything already moved is in the new context; run it again to finish.";

/**
 * A batch met an edit: its copy is already taken back. Within the move's
 * budget the batch is listed and carried again after a pause; past it, the
 * move stops and says so.
 */
export async function absorbConflict(pass: MoverPass, conflictsLeft: number): Promise<boolean> {
  const used = pass.conflicts ?? 0;
  if (used >= conflictsLeft) return false;
  pass.conflicts = used + 1;
  pass.remaining = true;
  await new Promise((resolve) => setTimeout(resolve, CONTEXT_MOVE_CONFLICT_PAUSE_MS));
  return true;
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const overlaps = (path: string, move: { from: string; to: string }) =>
  under(move.from, path) || under(path, move.from) || under(move.to, path) || under(path, move.to);

/** Words for a batch that stopped, never a provider's text. */
function stoppedMessage(code: ContextMoveFailureCode | string): string {
  switch (code) {
    case "DESTINATION_EXISTS":
      return "Something is already at that path in the other context, so the move stopped. Pick a name nothing there is using and run it again.";
    case "NOTE_CAP_REACHED":
      return "The context you are moving into is full, so the move stopped. Everything already moved is there; make room or level it up, then run it again.";
    case "CONFLICT":
      return CONFLICT_STOPPED;
    default:
      return "The move could not be completed. Nothing further was moved.";
  }
}

/**
 * Carry up to `batches` batches on the mover. `skipped` is the move's skip
 * list and is added to in place, as the action's own pass does.
 */
export async function carryOnMover(
  ctx: ActionCtx,
  input: {
    moveId: Id<"contextMoves">;
    row: MoveRow;
    source: Access;
    destination: Access;
    skipped: Skip[];
    origin: string;
    batches: number;
    conflictsLeft: number;
  },
): Promise<MoverPass> {
  const { row, skipped } = input;
  const pass: MoverPass = { movedObjects: 0, movedBytes: 0, remaining: true };

  const [sourceMoves, destinationMoves] = await Promise.all([
    ctx.runQuery(internal.functions.nodeMoves.active, { workspaceId: row.sourceWorkspaceId }),
    ctx.runQuery(internal.functions.nodeMoves.active, { workspaceId: row.destinationWorkspaceId }),
  ]);
  if (sourceMoves.some((move) => overlaps(row.from, move)) || destinationMoves.some((move) => overlaps(row.to, move))) {
    return { ...pass, retry: true };
  }

  const barrier = (side: "source" | "destination", operation: Record<string, unknown>) =>
    ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: side === "source" ? row.sourceWorkspaceId : row.destinationWorkspaceId,
      scope: input[side].scope,
      grantedNames: input[side].grantedNames,
      operation: operation as never,
    });
  const nothingYet = () => row.movedObjects + pass.movedObjects === 0;

  for (let batch = 0; batch < input.batches && pass.remaining; batch += 1) {
    const plan = await barrier("source", {
      kind: "contextMovePlan",
      from: row.from,
      to: row.to,
      skip: skipped.map((entry) => entry.path),
      maxObjectBytes: MIGRATION_OBJECT_BYTE_CAP,
    });
    if (plan.kind !== "contextMovePlanned") return { ...pass, failed: stoppedMessage("") };
    pass.remaining = plan.remaining;
    addSkips(skipped, plan.skipped);
    if (skipped.length > CONTEXT_MOVE_SKIP_CAP) return { ...pass, failed: skipCapMessage() };
    if (plan.objects.length === 0) {
      if (nothingYet() && skipped.length === 0) return { ...pass, failed: `There is nothing at ${row.from} to move.` };
      break;
    }

    const first = nothingYet();
    await barrier("destination", {
      kind: "contextMovePrepare",
      objects: plan.objects.map((object) => ({ destination: object.destination, sourceVisibility: object.sourceVisibility })),
      // Only while nothing of this move has landed: the check that refuses a
      // merge onto a folder the destination already has.
      ...(first ? { root: row.to } : {}),
    });

    const carried = await runContextMoveBatchOnMover(
      ctx,
      row.sourceWorkspaceId,
      {
        moveId: input.moveId,
        objects: plan.objects.map(({ source, destination, size }) => ({ source, destination, size })),
      },
      input.origin,
    );
    if (carried.kind === "unanswered" || carried.kind === "stale") return { ...pass, retry: true };
    if (carried.kind === "failed") return { ...pass, failed: stoppedMessage(carried.code) };

    addSkips(skipped, carried.skipped);
    if (carried.landed.length > 0) {
      await barrier("destination", {
        kind: "contextMoveArrived",
        paths: carried.landed.map((entry) => entry.destination),
        ...(first ? { root: row.to } : {}),
      });
      await barrier("source", { kind: "contextMoveForget", paths: carried.landed.map((entry) => entry.source) });
      pass.movedObjects += carried.landed.length;
      for (const entry of carried.landed) pass.movedBytes += entry.bytes;
    }
    if (skipped.length > CONTEXT_MOVE_SKIP_CAP) return { ...pass, failed: skipCapMessage() };
    if (carried.conflicts.length > 0 || carried.failure?.code === "CONFLICT") {
      // The mover took each edited note's copy back; listed again, the batch carries the edit.
      if (await absorbConflict(pass, input.conflictsLeft)) continue;
      return { ...pass, failed: CONFLICT_STOPPED };
    }
    if (carried.failure !== null) return { ...pass, failed: stoppedMessage(carried.failure.code) };
  }
  return pass;
}

function addSkips(skipped: Skip[], more: readonly Skip[]): void {
  for (const entry of more) {
    if (!skipped.some((seen) => seen.path === entry.path)) skipped.push(entry);
  }
}

function skipCapMessage(): string {
  return `More than ${CONTEXT_MOVE_SKIP_CAP} notes here are encrypted to this context and cannot move. Take them out of the encrypted state first, or move this in smaller pieces.`;
}

/* -------------------------------------------------------------------------- */
/*                         opening a batch for the mover                      */
/* -------------------------------------------------------------------------- */

export type ContextMoveTicket = {
  workspaceId: Id<"workspaces">;
  contextMoveId: Id<"contextMoves">;
  objects: { source: string; destination: string; size: number }[];
};

type Encryption = { managedEncryption: { mode: ManagedEncryptionOption["mode"] }; encryptionKey: { current: string; keys: Record<string, string> } };

export type ContextMoveMoverPage = {
  kind: "contextMove";
  source: GatewayCredential & { workspaceId: string };
  destination: GatewayCredential & { workspaceId: string };
  sourceEncryption?: Encryption;
  destinationEncryption?: Encryption;
  noteCap: number | null;
  objects: { source: string; destination: string; size: number }[];
  limits: { lanes: number; byteBudget: number; maxObjectBytes: number };
};

function encryption(option: ManagedEncryptionOption | null): Encryption | undefined {
  return option === null
    ? undefined
    : { managedEncryption: { mode: option.mode }, encryptionKey: { current: option.current, keys: option.keys } };
}

/**
 * Open one batch for the mover: both buckets, for the files the ticket names,
 * while the move is still running out of the ticket's workspace. Every file
 * must sit under the move's source and land under its destination, so a
 * ticket can only ever carry what this move planned.
 */
export async function openContextMovePage(ctx: ActionCtx, ticket: ContextMoveTicket): Promise<ContextMoveMoverPage | null> {
  const row: MoveRow | null = await ctx.runQuery(internal.functions.contextMoves.readMove, { moveId: ticket.contextMoveId });
  if (row === null || row.status !== "moving" || row.sourceWorkspaceId !== ticket.workspaceId) return null;
  if (ticket.objects.length === 0) return null;
  for (const object of ticket.objects) {
    if (!under(object.source, row.from) || !under(object.destination, row.to)) return null;
  }
  const [sourceCredential, destinationCredential]: (GatewayCredential | null)[] = await Promise.all([
    ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId: row.sourceWorkspaceId }),
    ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId: row.destinationWorkspaceId }),
  ]);
  if (sourceCredential === null || destinationCredential === null) throw new Error("SOURCE_UNAVAILABLE");
  const [sourceEncryption, destinationEncryption, noteCap] = await Promise.all([
    managedEncryptionOption(ctx, row.sourceWorkspaceId),
    managedEncryptionOption(ctx, row.destinationWorkspaceId),
    ctx.runQuery(internal.functions.billing.noteCap, { workspaceId: row.destinationWorkspaceId }).catch(() => null),
  ]);
  const sealedSource = encryption(sourceEncryption);
  const sealedDestination = encryption(destinationEncryption);
  return {
    kind: "contextMove",
    source: { ...sourceCredential, workspaceId: String(row.sourceWorkspaceId) },
    destination: { ...destinationCredential, workspaceId: String(row.destinationWorkspaceId) },
    ...(sealedSource === undefined ? {} : { sourceEncryption: sealedSource }),
    ...(sealedDestination === undefined ? {} : { destinationEncryption: sealedDestination }),
    noteCap,
    objects: ticket.objects,
    limits: { lanes: CONTEXT_MOVE_LANES, byteBudget: CONTEXT_MOVE_BYTE_BUDGET, maxObjectBytes: MIGRATION_OBJECT_BYTE_CAP },
  };
}
