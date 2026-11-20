/**
 * The Lab sandbox route's `nightly` op (`route.js`; Dev2, 2026-11-20: "okay, let's run it now"): checks who may run
 * what, then hands the run to `nightly.js`. `helpers` are the route's own (`draftConfig`, `refused`, `view`, `newIds`, `DAILY_SENDS`).
 */

import { json } from "../fromGateway/http_responses.js";
import { callSandbox, sandboxStub } from "./object.js";
import { RUNNING_STALE_MS } from "./harness.js";
import { runNightlyForReal, runNightlyInTestChat, runOf } from "./nightly.js";

/**
 * `nightly` in a test chat (Dev2, 2026-11-20: the nightly gets its own Lab page with Run now): the nightly graph on the
 * test chat's draft, over the test copy of the caller's own workspace (`nightly.js`). A 1:1 of their own only: the
 * nightly is a person's, never a group's or someone else's. Counts as a test text. Waits for the run and answers it.
 */
export async function nightlyInTestChat({ env, controlPlane, token, who, stub, origin, graph, helpers }, state, input) {
  // A nightly run in a test chat counts as a test text (`DAILY_SENDS`).
  const { draftConfig, refused, view, newIds, DAILY_SENDS } = helpers;
  const about = state.meta.chat;
  if (about.kind !== "one" || about.shared === true) return refused(400, "The nightly runs in a test chat of your own 1:1 with Tex: open one with source chat and no chatId.");
  const run = runOf(input);
  if (run === null) return refused(400, 'run is "dream" or "housekeeping"');
  if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
  const drafted = await draftConfig(controlPlane, token, about.versionId, graph, about.drawn === true ? about.config : undefined);
  if (drafted.error) return refused(...drafted.error);
  const day = new Date().toISOString().slice(0, 10);
  const counted = await callSandbox(sandboxStub(env, who.userId, "index0000000000"), "count", { key: `sends:${day}`, max: DAILY_SENDS });
  if (!counted.ok) return refused(429, `${DAILY_SENDS} test texts a day: try again tomorrow`);
  const answer = await controlPlane.labSandbox(token, "session", { chat: about.chat });
  if (answer?.status !== "ok") return refused(404, answer?.error ?? "This chat is no longer yours to test in.");
  const { at, eid, id } = newIds();
  const row = { id, eid, who: "Lab", text: `Run the nightly ${run} now`, at, prod: false, nightly: run };
  const claimed = await callSandbox(stub, "claim", { msgId: row.id, staleMs: RUNNING_STALE_MS });
  if (!claimed.ok) return refused(409, "a test text is still running: wait for its reply");
  try {
    await callSandbox(stub, "row.add", { row });
  } catch (error) {
    await callSandbox(stub, "release", { msgId: row.id }).catch(() => {});
    throw error;
  }
  const result = await runNightlyInTestChat({ env, stub, about, row, payload: answer.session, token, config: drafted.config ?? null, origin, run });
  return json({ msgId: row.id, ...result });
}

/** `nightly` with `real: true`: the nightly on the caller's own workspace, on main or a saved draft (never a drawn one). */
/** Real nightly runs a person may start a day: each spends a dream on their own notes. */
export const REAL_NIGHTLY_RUNS = 10;

export async function nightlyForReal({ env, controlPlane, token, who, origin, helpers }, input) {
  const { draftConfig, refused } = helpers;
  const run = runOf(input);
  if (run === null) return refused(400, 'run is "dream" or "housekeeping"');
  if (input.graph !== undefined && input.graph !== null) return refused(400, "A real run takes main or a saved draft (versionId), never a drawn graph.");
  const drafted = await draftConfig(controlPlane, token, input.versionId);
  if (drafted.error) return refused(...drafted.error);
  const day = new Date().toISOString().slice(0, 10);
  const counted = await callSandbox(sandboxStub(env, who.userId, "index0000000000"), "count", { key: `nightly:${day}`, max: REAL_NIGHTLY_RUNS });
  if (!counted.ok) return refused(429, `${REAL_NIGHTLY_RUNS} real nightly runs a day: try again tomorrow`);
  const answer = await controlPlane.labSandbox(token, "session", { chat: "me" });
  if (answer?.status !== "ok") return refused(404, answer?.error ?? "You have no 1:1 with Tex to run the nightly for.");
  console.log(JSON.stringify({ event: "lab_nightly_real", run, draft: typeof input.versionId === "string" ? input.versionId.slice(0, 40) : "main" }));
  return json({ real: true, ...(await runNightlyForReal({ env, payload: answer.session, token, config: drafted.config ?? null, origin, run })) });
}

