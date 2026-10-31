/**
 * Routines over HTTP (`docs/decisions/routines.md`). Registered in `http.ts`:
 *
 *  - `POST /gateway/routines` (gateway secret): a write touched a routine
 *    root (`routines/` or `tex/routines/`).
 *  - `POST /agent-texts/routines/due` (texting Worker's secret): the runs due
 *    now, each with a short-lived grant.
 *  - `POST /agent-texts/routines/result` (same): how one went, as a code.
 *
 * None of them carries note text in either direction.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { badRequest, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { INVALID_SCOPE } from "../routines/runs";
import { MAX_DUE_RUNS, isRoutineOutcome } from "../routines/model";

/**
 * `POST /gateway/routines` — `{ workspaceId, userId?, paths }` → `{ ok: true }`.
 *
 * The same answer whatever it names, like `/gateway/website`: a holder of the
 * gateway secret can make a workspace re-read its own routine folders
 * (`routines/` and `tex/routines/`), and name a writer who is kept only if
 * they can write there now. It learns
 * nothing, and it cannot add a row a scan of that workspace's own bucket would
 * not add.
 */
export async function gatewayRoutinesHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const answered = () => json({ ok: true });
  const workspaceId = stringField(body, "workspaceId");
  const userId = body.userId === undefined ? undefined : stringField(body, "userId");
  if (workspaceId === null || userId === null || !Array.isArray(body.paths)) return answered();
  const paths = body.paths.filter((path): path is string => typeof path === "string").slice(0, 200);
  try {
    await ctx.runMutation(internal.functions.routines.recordRoutineSignal, {
      workspaceId,
      ...(userId === undefined ? {} : { userId }),
      paths,
    });
  } catch {
    // Answered the same: a malformed id is not a different reply.
  }
  return answered();
}

/**
 * `POST /agent-texts/routines/due` — `{}` → every run due now (the cron), or
 * `{ scope: { workspaceId, path } }` → the one routine's run, if it is due now
 * (an alarm). Both → `{ runs: [{ runId, accessToken, path, timeZone, send,
 * phones, nextRunAt }] }`. A scope that does not name a workspace is a 400.
 *
 * The plaintext tokens are made here and returned once; only their hashes
 * reach the database, with a refresh hash nobody was given.
 */
export async function agentRoutinesDueHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const scope = dueScopeOf(body.scope);
  if (scope === "invalid") return badRequest();
  const plaintext: string[] = [];
  const tokens: Array<{ hashedAccessToken: string; hashedRefreshToken: string }> = [];
  const runIds: string[] = [];
  for (let i = 0; i < MAX_DUE_RUNS; i += 1) {
    const accessToken = `cat_${randomOpaqueToken(32)}`;
    plaintext.push(accessToken);
    tokens.push({
      hashedAccessToken: await hashToken(accessToken),
      hashedRefreshToken: await hashToken(`unissued_${randomOpaqueToken(32)}`),
    });
    runIds.push(`run_${randomOpaqueToken(16)}`);
  }
  let claimed;
  try {
    claimed = await ctx.runMutation(internal.functions.routines.claimDueRoutines, {
      runIds,
      tokens,
      ...(scope === null ? {} : { scope }),
    });
  } catch (error) {
    // Only a scope the table cannot read is a 400; anything else is the server's failure, as it always was.
    if (scope !== null && error instanceof ConvexError && error.data === INVALID_SCOPE) return badRequest();
    throw error;
  }
  return json({
    // A chat routine's run carries no token: the chat's own turn mints one.
    runs: claimed.map(({ token, ...run }) => (token === undefined ? run : { ...run, accessToken: plaintext[token]! })),
  });
}

/** The scope a due call names: none (`null`, the cron's), one routine, or `"invalid"`. */
function dueScopeOf(value: unknown): { workspaceId: string; path: string } | null | "invalid" {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null) return "invalid";
  const { workspaceId, path } = value as Record<string, unknown>;
  if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 128) return "invalid";
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || path.includes("\0")) return "invalid";
  return { workspaceId, path };
}

/**
 * `POST /agent-texts/routines/result` — `{ runId, outcome, texted }` →
 * `{ status: "recorded" | "unknown" }`. Any other field is ignored, and an
 * outcome outside the closed list is refused: nothing a run said is kept.
 */
export async function agentRoutinesResultHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const runId = stringField(body, "runId");
  const outcome = body.outcome;
  if (runId === null || runId.length > 128 || !isRoutineOutcome(outcome)) return badRequest();
  const status = await ctx.runMutation(internal.functions.routines.recordRoutineResult, { runId, outcome });
  return json({ status });
}
