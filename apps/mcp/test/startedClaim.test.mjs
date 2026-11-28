/**
 * "Started it" checked against what the turn started (`packages/tex/gateway/agent/startedClaim.js`, Architect item #7).
 * 2026-11-06: the only call was a steer into the MacBook's job, and the reply said the split now included the cloud
 * workers as a third part; nothing had started it.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `untriedWebCheck` not asking `startedClaimNotice`.
 *     → "the front door sends back a start claim the turn never made, once, with its facts as data" fails.
 *  2. `startedClaimNotice` ignoring the turn's starts.
 *     → "a start that went through, or a restart, backs the claim" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { claimsAStart, startedClaimNotice } from "../../../packages/tex/gateway/agent/startedClaim.js";
import { untriedWebCheck } from "../../../packages/tex/gateway/agent/untriedWeb.js";
import { stepOf } from "../../../packages/tex/gateway/agent/standsCheck.js";

// The 2026-11-06 reply began "Sent ✓", which the sent check sends back on its own; the claim after it is this check's.
const CLAIM = "Done. The split job now includes the Tex cloud workers as a third part.";

test("a start claim is told from a plain answer", () => {
  for (const said of [CLAIM, "I've started a background job for the Lisbon week.", "Kicked off two parts: one on your Mac, one in the cloud.", "Restarted all three jobs.", "Picked the YC job back up."]) assert.equal(claimsAStart(said), true, said);
  for (const said of ["I added it to your calendar.", "The job is still running.", "I haven't started a job yet.", "Want me to start a background job?", "I'll start it once a slot frees up.", "Here are three flats near Alfama."]) assert.equal(claimsAStart(said), false, said);
});

test("the front door sends back a start claim the turn never made, once, with its facts as data", async () => {
  const check = untriedWebCheck({ question: "add the cloud workers" });
  const call = check.wrap(async () => ({ content: [{ type: "text", text: "Passed their text on." }] }));
  await call("steer_background_job", { title: "Split project v2", note: "add cloud workers" });
  const notice = check.check(CLAIM);
  assert.ok(notice, "sent back");
  assert.deepEqual(JSON.parse(notice), { check: "start_claim", answer_claims: "job_started", started_this_turn: [], picked_back_up_this_turn: [], passed_to_running_jobs: ["Split project v2"] });
  assert.equal(check.check(CLAIM), null, "once");
});

test("a start that went through, or a restart, backs the claim", () => {
  for (const name of ["start_background_job", "plan_big_ask", "restart_background_job"]) assert.equal(startedClaimNotice(CLAIM, [stepOf(name, {}, { content: [] })]), null, name);
  assert.ok(startedClaimNotice(CLAIM, [stepOf("start_background_job", {}, { isError: true, content: [] })]), "a refused start backs nothing");
});

test("a job's report relayed is the job's word, not a claim of this turn", () => {
  assert.equal(untriedWebCheck({ reported: true }).check(CLAIM), null);
});
