/**
 * `tex_dev` `failures` (`src/texDev/tool.js`, `packages/shared/src/texFailures.cjs`; Dev2: triage of a Lab run read its
 * rows one by one; one call answers the failing rows with the ask, Tex's reply, tool calls, gold and the judge's reasons).
 *
 * Sabotage record (temporary local edits, reverted):
 *   texFailures.cjs failingRows never keeping a repeated row (the flaky clause gone)   "failingRows keeps failed and flaky rows" and the view test fail
 *   texFailures.cjs parseDetail cutting the judge's reason at its first ")"           "parseDetail reads the real example" and the view test fail
 *   texFailures.cjs tagsOf missed_checkin off (checkin: false)                          the tagsOf, grouped view and scoring tag tests fail (3)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTexDev } from "../src/texDev/tool.js";
import { guideText } from "../src/texDev/guide.js";
import { texDevToolDefinitions } from "../src/tools/schemas/texDev.js";
import { FAILURE_TAGS, failingRows, failureView, parseDetail, tagsOf } from "../../../packages/shared/src/texFailures.cjs";
import { repoConversation } from "../src/texDev/sets.js";

const textOf = (result) => result.content.find((c) => c.type === "text")?.text ?? "";
const jsonOf = (result) => JSON.parse(textOf(result));
const tool = (answers) => {
  const calls = [];
  const controlPlane = { async texDev(token, action, args) { calls.push({ action, args }); const a = answers[action]; return typeof a === "function" ? a(args) : (a ?? null); } };
  return { calls, call: createTexDev({ env: { APP_ORIGIN: "https://context.example" }, session: { accessToken: "tok" }, controlPlane }) };
};

const MUST = "Asks the one question, but states only Kenji's request. It never says what changed, and no change was made. (2 of 3 votes)";
const EXAMPLE = [
  "rounds: 2/24",
  "steps: tools search_email ok, send_email email failed, connect_google connect_google ok | answer check: let go (accepted) | outcome: quiet (send say_nothing)",
  `must: say what changed and ask the one question (${MUST})`,
  "held: never: sends a second text (none sent)",
  "Tex: Kenji's flight is delayed, so he's asking to push today's 2pm ep 41 recording to 3.",
  "Does 3 work for everyone?",
].join("\n");

test("parseDetail reads the real example: the reason with nested parentheses, the tools, the reply over its lines", () => {
  const d = parseDetail(EXAMPLE);
  assert.equal(d.rounds, "2/24");
  assert.equal(d.route, null);
  assert.deepEqual(d.tools, [
    { name: "search_email", ok: true },
    { name: "send_email", ok: false },
    { name: "connect_google", ok: true },
  ]);
  assert.equal(d.outcome, "quiet (send say_nothing)");
  assert.deepEqual(d.misses, [{ kind: "must", line: "say what changed and ask the one question", reason: MUST }]);
  assert.deepEqual(d.held, [{ kind: "never", line: "sends a second text", reason: "none sent" }]);
  assert.equal(d.tex, "Kenji's flight is delayed, so he's asking to push today's 2pm ep 41 recording to 3.\nDoes 3 work for everyone?");
});

test("parseDetail: tools none, a line with no reason, and an empty detail", () => {
  const none = parseDetail("steps: tools none | outcome: replied\nmust: say the date");
  assert.deepEqual(none.tools, []);
  assert.equal(none.steps, "tools none | outcome: replied");
  assert.deepEqual(none.misses, [{ kind: "must", line: "say the date", reason: null }]);
  assert.deepEqual(parseDetail(""), { rounds: null, route: null, steps: null, tools: [], outcome: null, misses: [], held: [], tex: "" });
});

test("failingRows keeps failed and flaky rows; it drops rows that did not run, ambiguous ones and passes", () => {
  const rows = [
    { convId: "a", msgIndex: 0, node: "fd", ok: false },
    { convId: "b", msgIndex: 1, node: "fd", ok: true, runs: 3, passes: 2 },
    { convId: "c", msgIndex: 2, node: "fd", ok: false, ran: false },
    { convId: "d", msgIndex: 3, node: "fd", ok: false, ambiguous: true },
    { convId: "e", msgIndex: 4, node: "fd", ok: true, runs: 3, passes: 3 },
    { convId: "f", msgIndex: 5, node: "router", ok: true },
  ];
  assert.deepEqual(failingRows(rows).map((r) => r.convId), ["a", "b"]);
});

test("the view: the failed fd row's ask, reply, tools, gold and judge reasons; a flaky row's passes", () => {
  const run = {
    id: "k9", set: "training", repeats: 3, commit: "abc",
    results: {
      score: { mean: 0.5 }, pass: 4, total: 8,
      rows: [
        { convId: "build-crew", msgIndex: 54, node: "fd", ok: false, runs: 3, passes: 0, detail: EXAMPLE },
        { convId: "build-crew", msgIndex: 54, node: "decide", ok: true, runs: 3, passes: 2, got: "read", want: "quick" },
      ],
      ambiguous: [{ convId: "x", msgIndex: 0, node: "fd", why: "gold reply fails" }],
    },
  };
  const view = failureView(run, repoConversation);
  assert.deepEqual(view.run, { id: "k9", set: "training", repeats: 3, commit: "abc", score: { mean: 0.5 }, pass: 4, total: 8 });
  assert.equal(view.count, 2);
  assert.equal(view.shown, 2);
  assert.deepEqual(view.ambiguous, run.results.ambiguous);
  const [fd, decide] = view.rows;
  assert.equal(fd.node, "fd", "front door rows come first");
  assert.equal(fd.passes, "0/3");
  assert.equal(fd.ask.who, "Check-in");
  assert.equal(fd.ask.via, "checkin");
  assert.equal(fd.ask.text, repoConversation("build-crew").msgs[54].text);
  assert.match(fd.reply, /^Kenji's flight is delayed/);
  assert.equal(fd.tools, "search_email, send_email ✗, connect_google");
  assert.equal(fd.outcome, "quiet (send say_nothing)");
  assert.deepEqual(fd.gold, { must: ["say what changed and ask the one question"] }, "an empty never list is left out");
  assert.equal(fd.got, undefined, "got is for the non-fd nodes");
  assert.deepEqual(fd.judge, [`must: say what changed and ask the one question — ${MUST.slice(0, 240)}`]);
  assert.equal(decide.passes, "2/3");
  assert.equal(decide.gold.want, "quick");
  assert.equal(decide.got, "read");
  assert.equal(decide.tools, undefined, "a row with no steps line says nothing of tools");
});

test("node, conv and limit narrow the view; count is every failing row the filters keep", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ convId: "build-crew", msgIndex: 54 + i, node: "fd", ok: false, detail: "" }));
  rows.push({ convId: "other", msgIndex: 1, node: "router", ok: false, want: "quick", got: "read" });
  const run = { id: "k", results: { rows } };
  assert.equal(failureView(run, () => null).count, 6);
  assert.equal(failureView(run, () => null, { node: "router" }).count, 1);
  assert.equal(failureView(run, () => null, { conv: "build-crew" }).count, 5);
  const capped = failureView(run, () => null, { limit: 2 });
  assert.equal(capped.count, 6);
  assert.equal(capped.shown, 2);
  assert.equal(failureView(run, () => null, { limit: 9999 }).shown, 6);
});

test("an ask longer than 300 characters is cut with an ellipsis", () => {
  const conv = { id: "z", msgs: [{ who: "Jo", text: "x".repeat(400) }] };
  const row = failureView({ id: "k", results: { rows: [{ convId: "z", msgIndex: 0, node: "fd", ok: false }] } }, () => conv).rows[0];
  assert.equal(row.ask.text, `${"x".repeat(300)}…`);
});

test("the action: a run's failing rows in one call; a missing or malformed id is refused", async () => {
  const run = { id: "k1", stage: "done", results: { score: null, pass: 0, total: 1, rows: [{ convId: "build-crew", msgIndex: 54, node: "fd", ok: false, runs: 1, passes: 0, detail: EXAMPLE }] } };
  const { calls, call } = tool({ runs: { status: "ok", run } });
  const view = jsonOf(await call("failures", { id: "k1", limit: 5 }));
  assert.deepEqual(calls, [{ action: "runs", args: { id: "k1" } }]);
  assert.equal(view.count, 1);
  assert.equal(view.rows[0].conv, "build-crew");
  assert.equal(view.rows[0].msg, 54);
  assert.equal((await call("failures", {})).isError, true);
  assert.equal((await call("failures", { id: "../x" })).isError, true);
  assert.equal(calls.length, 1, "a refused id never reaches the control plane");
});

test("a run with no scored rows yet says so, with its stage", async () => {
  const { call } = tool({ runs: { status: "ok", run: { id: "k2", stage: "running", results: null } } });
  const refused = await call("failures", { id: "k2" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /no scored rows yet \(stage: running\)/);
});

test("the guide and the schema name failures", () => {
  assert.match(guideText(), /- failures \{ id, node\?, conv\?, limit\?, group\? \}/);
  const def = texDevToolDefinitions()[0];
  assert.match(def.description, /\bfailures\b/);
  assert.match(def.inputSchema.properties.action.description, /\bfailures\b/);
});

const detailWith = (...lines) => lines.join("\n");
const CHECKIN = { via: "checkin", text: "Morning check-in" };

test("tagsOf: each rule's row gets its tag; a check-in msg is missed_checkin, first", () => {
  assert.deepEqual(FAILURE_TAGS, ["missed_checkin", "broken_deliverable", "facts", "didnt_act", "asked_instead", "too_long"]);
  const says = { detail: detailWith("must: say where it is and confirm it saved (no)") };
  assert.deepEqual(tagsOf(says, null), ["didnt_act"]);
  assert.deepEqual(tagsOf(says, CHECKIN), ["missed_checkin", "didnt_act"], "priority order: the check-in tag leads");
  assert.deepEqual(tagsOf({ detail: "never: add more paragraphs (it wrote four)" }, null), ["too_long"], "a never line about length is too_long, not didnt_act");
  assert.deepEqual(tagsOf({ detail: "must: ask only the two things it needs (x)" }, null), ["asked_instead"]);
  assert.deepEqual(tagsOf({ detail: "steps: tools none | outcome: replied\nmust: check the record for the claim (x)" }, null), ["facts", "didnt_act"]);
  assert.deepEqual(tagsOf({ detail: "steps: tools send_email failed | outcome: quiet\nmust: say hi (no)" }, null), ["didnt_act"], "a failed tool is didnt_act");
  assert.deepEqual(tagsOf({ detail: "must: show the picture (the image came out blank)" }, null), ["broken_deliverable"]);
  assert.deepEqual(tagsOf({ detail: "must: say hi (fine)" }, null), [], "no rule matches: empty, which reads as other");
  assert.deepEqual(tagsOf({}, null), []);
});

test("failureView group: rows filed under their first tag, counts, FAILURE_TAGS order with other last; a stored tags wins over computing", () => {
  const conv = { id: "k", msgs: [CHECKIN, { who: "Jo", text: "Where is the file?" }, { who: "Jo", text: "Long one" }, { who: "Jo", text: "Plain" }, { who: "Jo", text: "Router" }] };
  const convOf = (id) => (id === "k" ? conv : null);
  const run = {
    id: "g1",
    results: {
      score: null, pass: 1, total: 6,
      rows: [
        { convId: "k", msgIndex: 0, node: "fd", ok: false, detail: detailWith("must: say where it is and confirm it saved (x)") },
        { convId: "k", msgIndex: 1, node: "fd", ok: false, detail: detailWith("must: confirm it saved (x)") },
        { convId: "k", msgIndex: 2, node: "fd", ok: false, tags: ["too_long"], detail: detailWith("must: confirm it saved (x)") },
        { convId: "k", msgIndex: 3, node: "fd", ok: true, runs: 3, passes: 2, detail: "" },
        { convId: "k", msgIndex: 4, node: "router", ok: false, detail: "" },
        { convId: "k", msgIndex: 0, node: "decide", ok: true, runs: 3, passes: 3, detail: "" },
      ],
      ambiguous: [],
    },
  };
  const view = failureView(run, convOf, { group: true, limit: 1 });
  assert.equal(view.count, 5, "every failing row, the limit does not apply to the grouped view");
  assert.equal(view.shown, undefined, "a grouped answer has no shown count");
  assert.equal(view.rows, undefined);
  assert.deepEqual(view.groups.map((g) => [g.tag, g.count]), [["missed_checkin", 1], ["didnt_act", 1], ["too_long", 1], ["other", 2]], "empty groups omitted, other last");
  assert.equal(view.groups[0].rows[0], "k 0: Morning check-in → must: say where it is and confirm it saved — x");
  assert.equal(view.groups[2].rows[0], "k 2: Long one → must: confirm it saved — x", "the stored too_long tag files it, though its detail computes didnt_act");
  assert.equal(view.groups[3].rows.length, 2);
  const flat = failureView(run, convOf);
  assert.deepEqual(flat.rows.map((r) => [r.group, r.tags]), [["missed_checkin", ["missed_checkin", "didnt_act"]], ["didnt_act", ["didnt_act"]], ["too_long", ["too_long"]], ["other", []], ["other", []]]);
  assert.equal(failureView(run, convOf, { group: true, node: "router" }).count, 1, "node still narrows the grouped view");
  assert.deepEqual(failureView(run, convOf, { group: true, conv: "nope" }).groups, []);
});

test("a row with a stored tags list reads those tags, even when the detail would say otherwise", () => {
  const row = { convId: "z", msgIndex: 0, node: "fd", ok: false, tags: [], detail: detailWith("must: confirm it saved (x)") };
  const flat = failureView({ id: "t", results: { rows: [row] } }, () => null);
  assert.deepEqual(flat.rows[0].tags, []);
  assert.equal(flat.rows[0].group, "other");
});
