/** A turn that threw: withdraws the asks nobody was told about, records the failure, and answers or rethrows. One step of Tex's turn (`../texEntryPoint.js`). */

import { json } from "../../http/responses.js";
import { withdrawPending } from "../../tools/approvals.js";
import { BUILTIN_PROVIDER } from "../builtin.js";
import { ProviderError } from "../providers.js";
import { keepRun } from "../routine.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function recoverFromFailure(t, error) {
  const { begun, chatLog, ledger, logTurn, meter, opened, outcome, routine, runner, runs, session, steer, store, tex } = t;
outcome.clean = false;
if (steer !== null) await tex.step("steer_clear", () => begun.catch(() => {}).then(() => steer.clear()));
if (opened !== null) await tex.after("browser_close", () => opened.close());
await tex.after("ledger", () => chatLog?.flush());
await tex.step("usage_failed", () => meter(null, true));
/*
  An ask the person was never told about (the turn failed before its ask
  line went out) is withdrawn: left waiting, it would be released by the
  next bare "yes", which is about something else.
*/
await tex.step("withdraw_asks", () => withdrawPending(store, { userId: session.actorUserId, ids: ledger.asked.map((asked) => asked.id) })).catch(() => {});
if (runner) await tex.step("keep_run", () => keepRun(store, routine, runs, "failed", ""));
if (error instanceof ProviderError) {
  await tex.after("turn_row", logTurn("failed", error.model, error.timing, null));
  // Logged for an operator, opaque to the caller. `reason` is a phrase this
  // worker wrote and a status; `builtin.js` and `aiGateway.js` never put a
  // response body in it, because a provider's error body quotes the request.
  console.log(
    JSON.stringify({
      event: "agent_provider_error",
      workspace: session.workspaceId,
      grant: session.grantId,
      provider: BUILTIN_PROVIDER,
      reason: error.reason,
      status: error.status,
    }),
  );
  return json({ error: "model_unavailable" }, 502);
}
throw error;
}
// TEX ENTRY POINT: end
