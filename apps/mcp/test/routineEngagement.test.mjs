/**
 * Whether a routine still matters to them (Dev2, 2026-11-16: "the front door should know its a routine and reason if
 * the routine is relevant or stale, and ask the user if they still want that routine if they see it hasnt been
 * interacted with"). Read from the routine's runs and the chat's texts; the Front door judges from what it is told.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *   a Tex-made "(Not a text from them." line counted as theirs   "Tex's own runs never count as their answer" fails
 *   UNANSWERED_ASK check dropped (always asks)                    "two unanswered texts only ask it to weigh" fails
 *   answered() ignores the next run                               "a text after the next run answers that one" fails
 *   routineRunQuestion telling every run its standing              "only a routine run as a routine is told its standing" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { engagementSection, routineEngagement, UNANSWERED_ASK } from "../../../packages/tex/gateway/agent/routineEngagement.js";
import { DONE_WORD, routineQuestion, routineRunQuestion } from "../../../packages/tex/gateway/agent/routine.js";

const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 10, 13, 0);
const run = (h, outcome = "answered") => ({ at: T0 + h * H, outcome });
const theirs = (h, text = "ok") => ({ role: "user", at: T0 + h * H, text });

test("a run they answered is one followed by a text of theirs before the next run", () => {
  const runs = [run(0), run(24), run(48)];
  assert.deepEqual(routineEngagement(runs, [theirs(1)]), { texted: 3, unanswered: 2, lastAnsweredAt: T0, since: T0 + 24 * H });
  assert.deepEqual(routineEngagement(runs, [theirs(49)]), { texted: 3, unanswered: 0, lastAnsweredAt: T0 + 48 * H, since: null });
});

test("a text after the next run answers that one, not the one before", () => {
  const runs = [run(0), run(2)];
  assert.deepEqual(routineEngagement(runs, [theirs(3)]), { texted: 2, unanswered: 0, lastAnsweredAt: T0 + 2 * H, since: null });
  assert.equal(routineEngagement(runs, [theirs(1)]).unanswered, 1);
});

test("a last run counts as answered for a day only", () => {
  assert.equal(routineEngagement([run(0)], [theirs(23)]).unanswered, 0);
  assert.equal(routineEngagement([run(0)], [theirs(25)]).unanswered, 1);
});

test("runs that texted nothing are never counted, and Tex's own runs never count as their answer", () => {
  const runs = [run(0), run(1, "quiet"), run(2, "failed"), run(3, "finished")];
  assert.equal(routineEngagement(runs, []).texted, 2);
  const byTex = { role: "user", at: T0 + 4 * H, text: "(Not a text from them. A routine ran.)" };
  assert.equal(routineEngagement(runs, [byTex]).unanswered, 2);
  assert.equal(routineEngagement(runs, [{ role: "assistant", at: T0 + 4 * H, text: "hi" }]).unanswered, 2);
});

test("nothing is said of a routine that has not texted them", () => {
  assert.equal(engagementSection(routineEngagement([], []), "UTC"), "");
  assert.equal(engagementSection(undefined, "UTC"), "");
});

test("every run is told to weigh whether it is stale; two unanswered texts only ask it to weigh", () => {
  const said = engagementSection(routineEngagement([run(0), run(24)], []), "UTC");
  assert.match(said, /texted them 2 times/);
  assert.match(said, /They have not answered or reacted to any of them/);
  assert.match(said, /still relevant to them or has gone stale/);
  assert.doesNotMatch(said, /still want this routine/);
});

test(`${UNANSWERED_ASK} unanswered texts in a row: end it if plainly over, otherwise ask in one line whether they still want it`, () => {
  const runs = [run(0), run(24), run(48), run(72)];
  const said = engagementSection(routineEngagement(runs, [theirs(1)]), "America/New_York");
  assert.match(said, /last answered or reacted to one on/);
  assert.match(said, /Its last 3 texts, since .* got no answer or reaction/);
  assert.ok(said.includes(`start your answer with ${DONE_WORD}`));
  assert.match(said, /ask in one short line whether they still want this routine/);
});

test("the routine's question carries its standing, after the recent texts and before its own words", () => {
  const routine = { path: "tex/routines/daily/rent.md", body: "Remind them about rent.", cadence: { unit: "day", every: 1 }, settings: {} };
  const standing = engagementSection(routineEngagement([run(0), run(24), run(48)], []), "UTC");
  const q = routineQuestion(routine, { now: T0 + 72 * H, timeZone: "UTC", recent: "RECENT TEXTS", standing });
  assert.ok(q.indexOf("RECENT TEXTS") < q.indexOf("has gone stale"));
  assert.ok(q.indexOf("has gone stale") < q.indexOf("Remind them about rent."));
  assert.doesNotMatch(routineQuestion(routine, { now: T0, timeZone: "UTC" }), /gone stale/);
});

test("only a routine run as a routine is told its standing: live Tex's question is unchanged", async () => {
  const routine = { path: "tex/routines/daily/rent.md", body: "Remind them about rent.", cadence: { unit: "day", every: 1 }, settings: {} };
  const runs = [run(-72), run(-48), run(-24)].map((r) => ({ ...r, at: Date.now() + (r.at - T0), text: "Rent is due." }));
  const kept = {};
  const asRoutine = await routineRunQuestion({}, routine, runs, "UTC", { kept, standing: true });
  assert.match(asRoutine, /Its last 3 texts, since .* got no answer or reaction/);
  assert.match(asRoutine, /ask in one short line whether they still want this routine/);
  assert.deepEqual([kept.engagement.texted, kept.engagement.unanswered], [3, 3]);
  const live = await routineRunQuestion({}, routine, runs, "UTC", { kept: {} });
  assert.doesNotMatch(live, /gone stale|still want this routine/);
  const withoutNow = (q) => q.replace(/It is now [^\n]*/, "");
  assert.equal(withoutNow(live), withoutNow(await routineRunQuestion({}, routine, runs, "UTC")), "no options reads as before");
});
