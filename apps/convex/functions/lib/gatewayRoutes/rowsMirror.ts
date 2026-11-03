/**
 * `POST /gateway/rows/mirror` — `{ workspaceId, changes: [{ seq, op, record, objectAt }] }` →
 * `{ applied: [seq…], skipped: [{ seq, reason }] }`, behind the gateway's secret only (`gatewayRoute`).
 *
 * The caller is a workspace object that has just taken note writes; this writes Convex behind it, one change at a
 * time and in the order sent (`functions/objectRowsMirror.ts`). An op this does not know is skipped, and so is a
 * change whose shape the mutation refuses ("bad change"); a refused change is dropped, not retried, and so are the
 * ones the mutation answers `applied: false` for. A transient failure stops the batch: the answer then carries
 * `stopped: true`, with what was applied and skipped so far, and the caller sends the rest again. A body that is not
 * a batch is a 400.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { badRequest, json } from "../gatewayAuth";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The most changes one batch may carry. */
export const ROWS_MIRROR_MAX_CHANGES = 100;

/** Errors a Convex argument check throws, as `runMutation` surfaces them (`Validator error: ...`). */
const VALIDATION_ERROR = /validator/i;

export async function gatewayRowsMirrorHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const workspaceId = body.workspaceId;
  const changes = body.changes;
  if (typeof workspaceId !== "string" || !ID.test(workspaceId)) return badRequest();
  if (!Array.isArray(changes) || changes.length > ROWS_MIRROR_MAX_CHANGES) return badRequest();

  const applied: unknown[] = [];
  const skipped: Array<{ seq: unknown; reason: string }> = [];
  for (const change of changes) {
    const entry = (change !== null && typeof change === "object" ? change : {}) as Record<string, unknown>;
    const seq = entry.seq ?? null;
    if (entry.op !== "wrote") {
      skipped.push({ seq, reason: "unknown op" });
      continue;
    }
    try {
      const answer = await ctx.runMutation(internal.functions.objectRowsMirror.wrote, {
        workspaceId: workspaceId as Id<"workspaces">,
        objectAt: entry.objectAt as number,
        record: entry.record as never,
      });
      if (answer.applied) applied.push(seq);
      else skipped.push({ seq, reason: answer.reason });
    } catch (error) {
      // A shape the validator refused: this change alone is dropped. Anything else may be transient, so the batch
      // stops here and the caller sends the rest again.
      if (VALIDATION_ERROR.test(String((error as Error)?.message ?? error))) {
        skipped.push({ seq, reason: "bad change" });
        continue;
      }
      return json({ applied, skipped, stopped: true });
    }
  }
  return json({ applied, skipped });
}
