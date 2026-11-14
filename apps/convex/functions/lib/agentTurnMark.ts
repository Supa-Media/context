/**
 * A turn's small row (`agentTurnMarks`, `lib/schema/agentTurns.ts`): what the
 * staff console counts over a month, taken from the whole turn.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

type TurnFields = Omit<Doc<"agentTurns">, "_id" | "_creationTime">;

export function markOf(turn: Id<"agentTurns">, row: TurnFields) {
  return {
    turn,
    workspaceId: row.workspaceId,
    client: row.client,
    ...(row.kind === undefined ? {} : { kind: row.kind }),
    provider: row.provider,
    model: row.model,
    outcome: row.outcome,
    at: row.at,
    ms: row.ms,
    modelMs: row.modelMs,
    toolMs: row.toolMs,
    toolCalls: row.trace.filter((step) => step.kind === "tool" && step.tool !== undefined).length,
    ...(row.costMicroUsd === undefined ? {} : { costMicroUsd: row.costMicroUsd }),
  };
}

/** Insert a turn with its mark. */
export async function insertTurn(ctx: MutationCtx, row: TurnFields): Promise<Id<"agentTurns">> {
  const id = await ctx.db.insert("agentTurns", row);
  await ctx.db.insert("agentTurnMarks", markOf(id, row));
  return id;
}
