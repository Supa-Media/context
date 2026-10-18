/**
 * The request's half of a chunked keyed move (`rowMoveChunks.ts`): reading a
 * folder too big for one `plan` a page at a time, and paging the rows until
 * the move has finished, carrying the rules again if a page says they changed.
 *
 * The rows never depend on this: the watchdog finishes them if the request
 * stops (`nodeRowMoves.continueRowMove`). What only a request can do is the
 * bucket's side (the rules file, forwarding, icons, search, editing history),
 * so asking for the same move again resumes it (`rowMoveFor`) and does that.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { FileOpError } from "../fileOps/errors";
import type { FileStore } from "../fileOps/store";
import { PRIVACY_KEY } from "../privacy";
import { carryPrivacy } from "./movePrivacy";
import { touchNodesNow } from "./run";

/** Times one request carries the rules again for a move whose rules keep changing, before it says so. */
const RECARRY_ATTEMPTS = 5;

export interface RecordedMove {
  id: Id<"rowMoves">;
  to: string;
  trash: boolean;
  state: "moving" | "moved";
  left: number;
}

/**
 * The chunked move of `from` this request continues: one still moving, or one moved whose bucket side is
 * undone and that `matches` this request. A moved one that does not match is a request that stopped and a
 * name now asked for something else: it is let go, and the request goes on as a new one.
 */
export async function recordedMove(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  workspaceId: Id<"workspaces">,
  from: string,
  matches: (move: RecordedMove) => boolean,
): Promise<RecordedMove | null> {
  const recorded = await ctx.runQuery(internal.functions.nodeRowMoves.rowMoveFor, { workspaceId, from });
  if (recorded === null || recorded.state === "moving" || matches(recorded)) return recorded;
  await ctx.runMutation(internal.functions.nodeRowMoves.rowMoveSettled, { id: recorded.id });
  return null;
}

/** The live files under `from` and whether any is unkeyed: `plan`'s own, or every page of them when it was too large. */
export async function plannedFiles(
  ctx: Pick<ActionCtx, "runQuery">,
  workspaceId: Id<"workspaces">,
  from: string,
  plan: { files: string[]; unkeyed: boolean; tooLarge: boolean },
): Promise<{ files: string[]; unkeyed: boolean }> {
  if (!plan.tooLarge) return { files: plan.files, unkeyed: plan.unkeyed };
  const files: string[] = [];
  let unkeyed = false;
  let after: string | undefined;
  for (;;) {
    const page = await ctx.runQuery(internal.functions.nodeRowMoves.planPage, { workspaceId, from, ...(after === undefined ? {} : { after }) });
    files.push(...page.files);
    unkeyed = unkeyed || page.unkeyed;
    if (page.next === null || page.next === after) return { files, unkeyed };
    after = page.next;
  }
}

/**
 * Page a chunked move until it has finished. Answers every file the pages this
 * request ran moved, and the rows left at the old name. A file-mode move whose
 * rules changed has them carried again (`store`), as the start carried them; a
 * trash, which carries none, never asks.
 */
export async function driveRowMove(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; id: Id<"rowMoves">; from: string; to: string; store: FileStore },
): Promise<{ files: { from: string; to: string }[]; left: number }> {
  const files: { from: string; to: string }[] = [];
  let recarried = 0;
  for (;;) {
    const page = await ctx.runMutation(internal.functions.nodeRowMoves.rowMovePage, { id: args.id });
    files.push(...page.files);
    if (page.state === "done" || page.state === "gone") return { files, left: page.left };
    if (page.state === "moving") continue;
    // `rules_changed`: a rule was written since the rules were carried, so it is carried too before a row moves.
    recarried += 1;
    if (recarried > RECARRY_ATTEMPTS) {
      throw new FileOpError("CONFLICT", "The privacy rules kept changing while this folder moved. Move it again to finish.");
    }
    const carried = await carryPrivacy(args.store, args.from, args.to);
    if (carried === null) {
      throw new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; move the folder again to finish.");
    }
    await touchNodesNow(ctx, args.workspaceId, args.store, { paths: [], files: [PRIVACY_KEY] });
    await ctx.runMutation(internal.functions.nodeRowMoves.rowMoveRules, { id: args.id, privacyEtag: carried.etag });
  }
}
