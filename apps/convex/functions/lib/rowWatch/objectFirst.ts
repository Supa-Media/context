/**
 * Writes that may narrow, told to the workspace's object first.
 *
 * The control plane still takes tree writes from 30-odd places, and a mutation cannot call an object. So an action
 * that is about to narrow (take access back, move into a private folder, trash, remove a row) opens a mark in the
 * object before it runs its mutation: from that moment the object knows a change is coming, and a reader's question
 * waits for it or is sent to the control plane, which already has it (`apps/mcp/src/workspaceStore/marks.js`). The
 * mutation commits, its push lands, and the mark closes with the rows that carry the change. Nothing is ever served
 * from the object's older rows after the writer began, and nobody is told the change is done before the object has it.
 *
 * If the object cannot be told, the write is refused: the object goes first, or the change does not happen.
 * A workspace whose notes are not judged in its object needs no mark, and its write runs as before.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { randomOpaqueToken } from "../gatewayAuth";
import { objectDoor } from "./objectDoor";
import { MARK_TTL_MS } from "./markRules";
import { objectSettled } from "./drain";

type Options = Parameters<typeof objectDoor>[2];

/**
 * File operations (`lib/filesFns/operationValidators.ts`) that may take something away from someone who could see
 * it: a move (into a private folder), a trash, a delete, a visibility change, a hide. `files.runFileOperation` runs
 * these inside `objectFirst`. One that only adds (a write, a copy, a new folder, a restore) never narrows, and its
 * row reaches the object by the ordinary push. A narrowing write this list misses is logged by the row watch
 * (`workspace_object_unmarked_narrowing`).
 */
export const NARROWING_OPERATIONS: ReadonlySet<string> = new Set([
  "move",
  "nodesMoveStart",
  "nodesMoveBatch",
  "contextMoveExport",
  "contextMoveDelete",
  "contextMoveFinish",
  "archive",
  "archiveTidy",
  "trash",
  "delete",
  "visibilityLine",
  "removeNewFolder",
  "clearVault",
  "hideOldCopies",
  "eraseMessagesBackup",
  "pluginDelete",
  "pluginManagedUninstall",
  "pluginRename",
  "deleteWebsiteRelease",
  "emojiRemove",
  "emojiRename",
  "migrateStorage",
]);

/** A mark's token: random, URL-safe, and nothing else (`marks.js` takes 8 to 128 of `[A-Za-z0-9_-]`). */
function markToken(): string {
  return `m${randomOpaqueToken().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 63)}`;
}

/**
 * Run `write` (the action's mutation or mutations for this workspace) with a mark open in the workspace's object
 * from before it starts until its change has reached the object. Answers what `write` answered.
 */
export async function objectFirst<T>(ctx: ActionCtx, workspaceId: Id<"workspaces">, write: () => Promise<T>, options: Options = {}): Promise<T> {
  const token = markToken();
  if (!(await ctx.runMutation(internal.functions.workspaceObjectMarks.open, { workspaceId, token, now: Date.now() }))) {
    const result = await write();
    await objectSettled(ctx, workspaceId);
    return result;
  }
  const call = objectDoor(ctx, workspaceId, options);
  try {
    await call("ws.mark.open", { token, ttlMs: MARK_TTL_MS });
  } catch (error) {
    await ctx.runMutation(internal.functions.workspaceObjectMarks.drop, { tokens: [token] });
    console.warn(JSON.stringify({ event: "workspace_object_mark_refused", workspaceId, reason: error instanceof Error ? error.message : "failed" }));
    throw error;
  }
  try {
    return await write();
  } finally {
    // Whether `write` answered or threw (one of several mutations may have committed before another failed), the
    // mark closes only once what committed is in the object. Settled: every change written before now is there.
    // Not settled: the push goes on retrying and closes the mark when it lands; until then the object says behind.
    await ctx.runMutation(internal.functions.workspaceObjectMarks.done, { token, at: Date.now() });
    if (await objectSettled(ctx, workspaceId)) await closeMark(ctx, call, workspaceId, token);
  }
}

async function closeMark(ctx: ActionCtx, call: ReturnType<typeof objectDoor>, workspaceId: Id<"workspaces">, token: string): Promise<void> {
  try {
    await call("ws.mark.close", { tokens: [token] });
    await ctx.runMutation(internal.functions.workspaceObjectMarks.drop, { tokens: [token] });
  } catch (error) {
    // Left open: the next push closes it once its writer said done, or the object lets it expire.
    console.warn(JSON.stringify({ event: "workspace_object_mark_close_failed", workspaceId, reason: error instanceof Error ? error.message : "failed" }));
  }
}

/** A file operation, inside `objectFirst` when its kind may narrow (`files.runFileOperation`). */
export async function operationFirst<A extends { workspaceId: Id<"workspaces">; operation: { kind: string } }, T>(
  ctx: ActionCtx,
  args: A,
  run: (ctx: ActionCtx, args: A) => Promise<T>,
): Promise<T> {
  if (!NARROWING_OPERATIONS.has(args.operation.kind)) return await run(ctx, args);
  return await objectFirst(ctx, args.workspaceId, () => run(ctx, args));
}
