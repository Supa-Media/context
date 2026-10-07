/**
 * Routines over HTTP (`docs/decisions/routines.md`). Registered in `http.ts`:
 *
 *  - `POST /gateway/routines` (gateway secret): a write touched `routines/`.
 *  - `POST /agent-texts/routines/due` (texting Worker's secret): the runs due
 *    now, each with a short-lived grant.
 *  - `POST /agent-texts/routines/result` (same): how one went, as a code.
 *
 * None of them carries note text in either direction.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { badRequest, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { MAX_DUE_RUNS, isRoutineOutcome } from "../routines/model";

/**
 * `POST /gateway/routines` — `{ workspaceId, userId?, paths }` → `{ ok: true }`.
 *
 * The same answer whatever it names, like `/gateway/website`: a holder of the
 * gateway secret can make a workspace re-read its own `routines/` folder, and
 * name a writer who is kept only if they can write there now. It learns
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
 * `POST /agent-texts/routines/due` — `{}` →
 * `{ runs: [{ runId, accessToken, path, timeZone, send, phones }] }`.
 *
 * The plaintext tokens are made here and returned once; only their hashes
 * reach the database, with a refresh hash nobody was given.
 */
export async function agentRoutinesDueHandler(
  ctx: ActionCtx,
  _body: Record<string, unknown>,
): Promise<Response> {
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
  const claimed = await ctx.runMutation(internal.functions.routines.claimDueRoutines, { runIds, tokens });
  return json({
    runs: claimed.map(({ token, ...run }) => ({ ...run, accessToken: plaintext[token]! })),
  });
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
