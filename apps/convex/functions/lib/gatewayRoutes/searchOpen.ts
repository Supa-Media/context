import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json, stringField } from "../gatewayAuth";
import { isActorId, isHitId } from "../searchTimingIds";

/**
 * `POST /gateway/search-open { workspaceId, actor, hit }` (`workspaceId` is the workspace the note was read from, checked for shape only: a match is by hash, across workspaces) — the gateway handed
 * back a note's content to an AI client or Tex, for a result of its search:
 * the first such open is the search's quality (`functions/searchTimings.ts`).
 *
 * The same auth and the same "answered 200" rule as `/gateway/search-timing`.
 * `recorded` says the request was accepted, not that it matched a search: a
 * fetch with no search in the last ten minutes is simply not counted.
 */
export async function gatewaySearchOpenHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const workspaceId = stringField(body, "workspaceId");
  const actor = stringField(body, "actor");
  const hit = stringField(body, "hit");
  if (workspaceId === null || !isActorId(actor) || !isHitId(hit)) {
    return json({ recorded: false });
  }
  try {
    await ctx.runMutation(internal.functions.searchTimings.markOpened, { actor, hit });
    return json({ recorded: true });
  } catch {
    return json({ recorded: false });
  }
}
