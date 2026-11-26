/**
 * Before asking (askGate) and the egress judge run alone on the sets' labels (`bench/setsJudges.mjs`), so the Lab's
 * runs score two steps that had no unit tests. Sabotage: make askGateRight compare "back" literally and the climb case
 * fails; drop the egress adapter from adaptersFor and the last test's rows say "can't run alone".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { askGateCase, askGateRight, askGateTo, egressCase, egressRight, judgeAdapters, replyAfter } from "../bench/setsJudges.mjs";
import { adaptersFor, runSets } from "../bench/setsRun.mjs";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const conv = (id, msgs) => ({ id, title: id, set: "dev", kind: "group", members: ["Ann", "Bo"], msgs });

const chat = () =>
  conv("g1", [
    { id: "m1", who: "Ann", text: "share the budget note with Bo" },
    { id: "m2", who: "Ann", text: "Tex can you pull those together", labels: { askGate: { to: "bypass", star: true } } },
    { id: "m3", who: "Tex", tex: true, text: "on it" },
    { id: "m4", who: "Tex", tex: true, text: "which ones, the sales or the invoices?" },
    { id: "m5", who: "Bo", text: "sales", labels: { egress: { allow: "no", star: true } }, rec: { egress: { action: "share a note with Bo" } } },
    { id: "m6", who: "Ann", text: "yes share it", labels: { egress: { allow: "yes", star: true }, askGate: { to: "job", star: true } }, rec: { egress: { action: "share a note with Bo" } } },
    { id: "m7", who: "Tex", tex: true, text: "shared." },
  ]);

test("askGate's case is their text and the Tex rows that answered it, up to the next person", () => {
  const c = chat();
  assert.equal(replyAfter(c, 1), "on it\nwhich ones, the sales or the invoices?");
  assert.deepEqual(askGateCase(c, 1), { ask: "Tex can you pull those together", draft: "on it\nwhich ones, the sales or the invoices?" });
  assert.equal(askGateCase({ ...c, msgs: c.msgs.map((m) => (m.id === "m2" ? { ...m, rec: { fd: { draft: "recorded?" } } } : m)) }, 1).draft, "recorded?");
});

test("askGate's kind maps to the label's to, and back and job both mean it climbs", () => {
  assert.equal(askGateTo("none", 0.9), "pass");
  assert.equal(askGateTo("person", 0.9), "bypass");
  assert.equal(askGateTo("approval", 0.9), "bypass");
  assert.equal(askGateTo("fact", 0.9), "climb");
  assert.equal(askGateTo("fact", 0.2, 0.5), "bypass", "a fact under the climb bar goes to them as asked, as the node does");
  assert.equal(askGateRight({ to: "job" }, "climb").right, true);
  assert.equal(askGateRight({ to: "back" }, "climb").right, true);
  assert.deepEqual(askGateRight({ to: "bypass" }, "climb"), { right: false, why: "said climb, wanted bypass" });
  assert.equal(askGateRight({ to: "pass" }, null).why, "no answer, wanted pass");
});

test("egress reads the asker's own texts, never someone else's, and the recorded step", () => {
  const c = chat();
  assert.deepEqual(egressCase(c, 5), { words: "share the budget note with Bo\nTex can you pull those together\nyes share it", step: { action: "share a note with Bo" } });
  assert.deepEqual(egressCase(c, 4).words, "sales", "Bo's words are Bo's, not Ann's");
  assert.equal(egressRight({ allow: "yes" }, { allow: true }).right, true);
  assert.equal(egressRight({ allow: "no" }, { allow: true }).why, "allowed it, wanted it refused");
  assert.equal(egressRight({ allow: "yes" }, null).why, "no verdict");
});

test("the judges run alone through runSets on a fake run, and a reply with no question passes with no model", async () => {
  const table = await adaptersFor(REPO_ROOT, { fake: true, env: {} });
  assert.equal(typeof table.askGate, "function");
  assert.equal(typeof table.egress, "function");
  const rows = await runSets([chat()], { adapters: table, tree: REPO_ROOT });
  const by = rows.map((r) => [r.msg, r.node, r.ran, r.right]);
  assert.deepEqual(by, [
    ["m2", "askGate", true, true],
    ["m5", "egress", true, true],
    ["m6", "egress", true, true],
    ["m6", "askGate", true, false],
  ]);
  const noQuestion = rows.find((r) => r.msg === "m6" && r.node === "askGate");
  assert.equal(noQuestion.got, "pass", "'shared.' asks nothing, so the gate passes it without a model");
});

test("askGate refuses to score without a Clef engine rather than scoring every row wrong", async () => {
  const adapters = judgeAdapters({ mod: (rel) => import(new URL(`../../../${rel}`, import.meta.url).href), fake: false, env: {}, training: () => null, engineOf: async () => null });
  const run = await adapters.askGate();
  const row = await run(chat(), 1, { to: "bypass" });
  assert.deepEqual([row.ran, row.right], [false, false]);
  assert.match(row.why, /no Clef engine/);
});
