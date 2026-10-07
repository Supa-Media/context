import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { json, stringField } from "../gatewayAuth";
import type { SearchAnsweredBy } from "../searchTiming";

const ANSWERED_BY: ReadonlySet<string> = new Set(["fast", "index", "scan", "none", "failed"]);

/**
 * `POST /gateway/search-timing` — how long an AI client's search took, for the
 * search timing log (`functions/searchTimings.ts`).
 *
 * Behind the gateway's own secret, like `/gateway/usage`, and for the same
 * reason the workspace id is taken as given: the gateway has just resolved a
 * grant to get it, and an id for a workspace that does not exist writes
 * nothing. What crosses is a workspace id, a word from a closed list, a
 * boolean and a number. No query, no path, no count of anything in the
 * workspace.
 *
 * **A failure here is answered 200**, `/gateway/usage`'s rule: the gateway
 * sends this behind its own response, and a timing is never worth a retry.
 */
export async function gatewaySearchTimingHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const workspaceId = stringField(body, "workspaceId");
  const answeredBy = stringField(body, "answeredBy");
  const { found, ms } = body;
  if (
    workspaceId === null ||
    answeredBy === null ||
    !ANSWERED_BY.has(answeredBy) ||
    typeof found !== "boolean" ||
    typeof ms !== "number"
  ) {
    return json({ recorded: false });
  }
  try {
    await ctx.runMutation(internal.functions.searchTimings.record, {
      // Checked by the mutation's own validator: a malformed id is a refused
      // call, not a stored row.
      workspaceId: workspaceId as Id<"workspaces">,
      surface: "ai",
      answeredBy: answeredBy as SearchAnsweredBy,
      found,
      ms,
    });
    return json({ recorded: true });
  } catch {
    return json({ recorded: false });
  }
}
