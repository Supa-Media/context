/** A turn that threw: withdraws the asks nobody was told about, records the failure, and answers or rethrows. One step of Tex's turn (`../texEntryPoint.js`). */

import { json } from "../../../../../apps/mcp/src/http/responses.js";
import { withdrawPending } from "../../../../../apps/mcp/src/tools/approvals.js";
import { BUILTIN_PROVIDER } from "../builtin.js";
import { ProviderError } from "../providers.js";
import { keepRun } from "../routine.js";
import { stepEntry } from "../ledger.js";
import { waitBefore } from "../turnLog.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function recoverFromFailure(t, error) {
  const { begun, body, chatLog, ledger, ledgerTurn, logTurn, meter, opened, outcome, received, routine, runner, runs, session, steer, store, tex } = t;
outcome.clean = false;
if (steer !== null) await tex.step("steer_clear", () => begun.catch(() => {}).then(() => steer.clear()));
if (opened !== null) await tex.after("browser_close", () => opened.close());
tex.logTo?.(chatLog, ledgerTurn); // the steps it took before it threw, with which one failed (`texTiming.js`)
/*
  The failed turn's own line in the chat's record, where a reply would have
  been: what failed and why, each model round and payer it tried, how long it
  waited and ran. `tex_dev turns` and Replay list a turn by its reply or this
  line, so a turn that answered nothing is still found and traced (Dev2,
  2026-11-19: "failed turns not being recorded is a huge gap").
*/
chatLog?.write(failedEntry(t, error, { turn: ledgerTurn, body, received }));
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

/** The `failed` step a turn that threw leaves in the chat's record: never the question or a provider's words. */
export function failedEntry(t, error, { turn, body, received }) {
  const trace = Array.isArray(error?.timing?.trace) ? error.timing.trace : [];
  const rounds = trace.filter((r) => r && (r.kind === "model" || r.kind === "fallback")).map((r) => ({
    kind: r.kind, model: r.model, ...(r.from ? { from: r.from } : {}), ok: r.ok !== false, ms: r.ms ?? null,
    ...(r.status === undefined || r.status === null ? {} : { status: r.status }),
    ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    ...(Array.isArray(r.payers) ? { payers: r.payers } : {}),
  }));
  const provider = error instanceof ProviderError;
  return stepEntry({
    step: "failed",
    ok: false,
    ms: Number.isFinite(received) ? Date.now() - received : null,
    model: typeof error?.model === "string" ? error.model : null,
    reason: provider ? String(error.reason ?? "provider error") : `threw ${typeof error?.name === "string" && /^[\w.-]{1,40}$/.test(error.name) ? error.name : "error"}`,
    input: { waitMs: Number.isFinite(received) ? waitBefore(body?.arrivedAt, received) : null, at: t.drafts === undefined ? "door" : "front door" },
    output: { rounds, ...(provider && error.status !== null && error.status !== undefined ? { status: error.status } : {}), ...(Array.isArray(error?.payers) ? { payers: error.payers } : {}) },
  }, { turn });
}
