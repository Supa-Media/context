/**
 * Lab gaps found simplifying Tex's graph in a draft (2026-11-16): a test chat on a draft that adds or removes steps ran
 * main's steps and its card never said so; a turn's whole answer was 77,000 characters; no count of how often each
 * step ran over days; the Queue's logged wait was "no run"; a failed Memory nudge said only "failed".
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *   draftFit() always answering asDrawn: true             "a draft that adds and removes steps says what of it cannot run" fails
 *   runCard() leaving out ranAs                            "a card on such a draft opens with how it really ran" fails
 *   turnFrom() listing stage timings when brief            "a turn is brief by default" fails
 *   runOf() ignoring the reply's waitMs                    "node_stats counts each step's runs" fails (lanes missing)
 *   chatStepsOf() without the queue's wait                 "the Queue's logged wait is a step of the run" fails
 *   failedAt() dropping the error's name                   "a failed nudge says where and why" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHELF_NODES, draftFit, TEX_CONFIG, withDraft } from "../src/agent/texConfig.js";
import { ranAsOf, runCard } from "../src/texDev/sandbox.js";
import { turnFrom } from "../src/texDev/probe.js";
import { nodeStatsAnswer, runOf, tally } from "../src/texDev/nodeStats.js";
import { chatStepsOf } from "../src/labSandbox/chatRun.js";
import { failedAt } from "../src/agent/memoryNudge.js";

const clone = (x) => JSON.parse(JSON.stringify(x));
const main = () => ({ nodes: clone(TEX_CONFIG.nodes), edges: clone(TEX_CONFIG.edges) });

/** A draft that merges Reflect and Memory nudge into one new step, `id`: one with no code ("ponder"), or one built ahead ("learn"). */
function mergedDraft(id = "ponder", label = "Ponder") {
  const g = main();
  g.nodes = g.nodes.filter((n) => n.id !== "reflect" && n.id !== "nudge");
  g.nodes.push({ ...clone(TEX_CONFIG.nodes.find((n) => n.id === "nudge")), id, label });
  g.edges = g.edges.filter((e) => e.to !== "reflect" && e.to !== "nudge" && e.from !== "reflect" && e.from !== "nudge");
  g.edges.push({ from: "send", to: id, mode: "background", when: ["fired"] });
  return g;
}

test("main, and a draft that only changes what the gateway can run, run as drawn", () => {
  assert.deepEqual(draftFit(TEX_CONFIG, null), { asDrawn: true });
  assert.deepEqual(draftFit(TEX_CONFIG, main()), { asDrawn: true });
  const g = main();
  g.nodes.find((n) => n.id === "fd").effort = "high";
  g.nodes.find((n) => n.id === "classifier").on = false;
  assert.deepEqual(draftFit(TEX_CONFIG, g), { asDrawn: true });
});

test("a draft that adds and removes steps says what of it cannot run", () => {
  const fit = draftFit(TEX_CONFIG, mergedDraft());
  assert.equal(fit.asDrawn, false);
  assert.deepEqual(fit.noCode, ["ponder (Ponder)"]);
  assert.deepEqual(fit.removed, ["nudge (Memory nudge)", "reflect (Reflect)"]);
  assert.equal(fit.wires, "main", "a wire to a step with no code makes the whole wiring main's, as withDraft runs it");
  assert.deepEqual(fit.badWires, ["send → ponder"]);
  assert.match(fit.says, /1 step the draft adds has no code yet/);
  assert.match(fit.says, /2 steps the draft removes still run as main's/);
  // The fit is the rules withDraft applies, not a guess: what it calls main's is what runs.
  const ran = withDraft(TEX_CONFIG, mergedDraft());
  assert.ok(ran.nodes.some((n) => n.id === "nudge") && !ran.nodes.some((n) => n.id === "ponder"));
  assert.equal(ran.edges, TEX_CONFIG.edges);
});

test("a draft that draws a step built ahead of the config runs it, with the draft's wires, and its removed steps no more", () => {
  // Dev2, 2026-11-16: a draft's new steps are built in main's code first (`SHELF_NODES`), so a draft can run them.
  assert.ok(SHELF_NODES.includes("learn"));
  const fit = draftFit(TEX_CONFIG, mergedDraft("learn", "Learn"));
  assert.deepEqual(fit, { asDrawn: true });
  const ran = withDraft(TEX_CONFIG, mergedDraft("learn", "Learn"));
  assert.ok(ran.nodes.some((n) => n.id === "learn"), "the step built ahead is in the turn's config");
  assert.ok(ran.edges.some((e) => e.from === "send" && e.to === "learn"), "the draft's wires run");
  assert.ok(!ran.edges.some((e) => e.to === "nudge" || e.to === "reflect"), "no wire reaches a removed step");
  assert.ok(ran.nodes.some((n) => n.id === "nudge"), "a removed step stays for the settings code reads off it");
  assert.ok(!TEX_CONFIG.nodes.some((n) => n.id === "learn"), "main's own config never has it");
});

test("a setting the gateway could not take is named", () => {
  const g = main();
  g.nodes.find((n) => n.id === "fd").model = "lab-only-model";
  const fit = draftFit(TEX_CONFIG, g);
  assert.equal(fit.asDrawn, false);
  assert.deepEqual(fit.unapplied, ['fd.model "lab-only-model"']);
  assert.equal(fit.wires, "draft");
});

test("a card on such a draft opens with how it really ran", () => {
  const fit = draftFit(TEX_CONFIG, mergedDraft());
  const steps = [
    { node: "fd", out: '{"when":["done"]}', ms: 900, ok: true },
    { node: "send", out: '{"when":["sent"]}', ms: 0, ok: true },
    { node: "nudge", out: '{"outcome":"not_yet"}', ms: 3, ok: true },
  ];
  const rows = [{ id: "t1", who: "You", text: "hi", at: 1 }, { id: "t1r", reply: "t1", who: "Tex", text: "hey", at: 2, ms: 1, steps }];
  const card = runCard({ rows, msgId: "t1", graph: withDraft(TEX_CONFIG, mergedDraft()), draft: "vdraft", fit });
  assert.equal(card.ranAs.asDrawn, false);
  assert.match(card.ranAs.says, /^Not the draft as drawn/);
  assert.deepEqual(card.ranAs.notRunNoCode, ["ponder (Ponder)"]);
  assert.deepEqual(card.ranAs.removedButRan, ["nudge (Memory nudge)"], "only the removed steps this run's log shows ran");
  assert.match(card.ranAs.wires, /main's/);
  assert.equal(Object.keys(card).indexOf("ranAs"), Object.keys(card).indexOf("draft") + 1, "said right after which draft, before anything else");
  // Main's own run carries none.
  assert.equal(runCard({ rows, msgId: "t1", graph: TEX_CONFIG, fit: { asDrawn: true } }).ranAs, undefined);
  assert.deepEqual(ranAsOf({ asDrawn: false, says: "x.", wires: "draft" }, []).wires, "the draft's");
});

test("a lone text triage sends to the Queue skips Decide as the config's wires say", () => {
  const steps = [{ node: "triage", out: '{"to":"tex"}', ms: 0, ok: true }, { node: "lanes", out: "{}", ms: 200, ok: true }];
  const rows = [{ id: "t1", who: "You", text: "hi", at: 1 }, { id: "t1r", reply: "t1", who: "Tex", text: "hey", at: 2, ms: 1, steps }];
  const card = runCard({ rows, msgId: "t1", graph: TEX_CONFIG });
  const decide = card.notFired.find((n) => n.node === "decide");
  // The config says what the code does (Dev2, 2026-11-16): Triage sends a lone text straight to the Queue, never Decide.
  assert.match(decide.why, /triage said \[tex\], the wait wire wants \[judge, running\]/);
  assert.ok(!card.notFired.some((n) => n.node === "lanes"), "the Queue ran: its wait is a step of the run");
});

test("the Queue's logged wait is a step of the run, before the turn's steps", () => {
  const entries = [
    { kind: "step", step: "triage", output: { to: "tex" }, ms: 0, ok: true, at: 10 },
    { kind: "reply", turn: "t", at: 500, timing: { waitMs: 202, replyMs: 300 } },
    { kind: "step", step: "node", name: "fd", output: { when: ["done"] }, ms: 280, at: 500 },
  ];
  const steps = chatStepsOf(entries);
  assert.deepEqual(steps.map((s) => s.node), ["triage", "lanes", "fd"]);
  assert.equal(steps[1].ms, 202);
  assert.deepEqual(chatStepsOf(entries.filter((e) => e.kind !== "reply")).map((s) => s.node), ["triage", "fd"], "no wait logged, no Queue step");
});

/** A busy turn as the history file keeps it: 40 stage timings, long thinking, a few nodes. */
function busyTurn() {
  const mine = [{ kind: "thinking", at: 1, ms: 6000, text: "t".repeat(5000), turn: "x" }];
  for (let i = 0; i < 40; i += 1) mine.push({ kind: "step", step: "timing", name: `stage${i}`, ms: i, ok: true, at: 2, turn: "x" });
  mine.push({ kind: "reply", at: 3, ms: 9000, turn: "x", text: "hey", timing: { waitMs: 5, replyMs: 9000, steps: Array.from({ length: 40 }, (_, i) => ({ name: `stage${i}`, at: 0, ms: i })), rounds: [] } });
  for (const name of ["readTheText", "fd", "send"]) mine.push({ kind: "step", step: "node", name, input: { big: "i".repeat(3000) }, output: { when: ["next"] }, ms: 1, at: 4, turn: "x" });
  return mine;
}

test("a turn is brief by default, and whole with detail all", () => {
  const brief = turnFrom(busyTurn());
  const all = turnFrom(busyTurn(), { detail: "all" });
  assert.equal(brief.order.filter((e) => e.label.startsWith("step timing")).length, 0, "stage timings counted, not listed");
  assert.equal(all.order.filter((e) => e.label.startsWith("step timing")).length, 40);
  assert.match(brief.summary.detail, /40 stage timing entries not listed/);
  assert.match(brief.summary.timing.steps, /40 stage timings/);
  assert.ok(Array.isArray(all.summary.timing.steps));
  assert.deepEqual(brief.summary.nodes, ["readTheText", "fd", "send"], "every node still named");
  assert.ok(brief.summary.slowest.some((s) => s.what === "step timing stage39"), "the slow stages are still named");
  assert.ok(JSON.stringify(brief).length < JSON.stringify(all).length / 2, "brief is much smaller");
  assert.ok(brief.order.find((e) => e.kind === "thinking").text.length < 600);
  // A failed stage is listed even when brief.
  const failing = busyTurn();
  failing[5].ok = false;
  assert.equal(turnFrom(failing).order.filter((e) => e.label.startsWith("step timing")).length, 1);
});

test("node_stats counts each step's runs, failures, time and what it said, and names the steps that never ran", async () => {
  const entries = [
    { kind: "reply", turn: "a", at: 1, timing: { waitMs: 40 } },
    { kind: "reply", turn: "b", at: 2, timing: { waitMs: 60 } },
    { kind: "step", step: "triage", output: { to: "tex" }, ms: 0, ok: true, at: 1 },
    { kind: "step", step: { name: "decide", ok: true, ms: 300, output: { when: ["speak"] } }, at: 2 },
    { kind: "step", step: "node", name: "nudge", turn: "a", output: { outcome: "not_yet" }, ms: 2, at: 1 },
    { kind: "step", step: "node", name: "nudge", turn: "b", output: { outcome: "failed", error: "TypeError" }, ms: 5, at: 2 },
    { kind: "step", step: "node", name: "fd", turn: "a", output: { when: ["drafted"] }, ms: 9000, own: 8000, at: 1 },
    { kind: "step", step: "timing", name: "model", ms: 6000, at: 1 },
    { kind: "step", step: "send", name: "delivery", ms: 1, at: 1 },
  ];
  const t = tally(entries);
  const by = Object.fromEntries(t.nodes.map((n) => [n.node, n]));
  assert.equal(t.replies, 2);
  assert.equal(by.lanes.runs, 2);
  assert.equal(by.nudge.runs, 2);
  assert.equal(by.nudge.failed, 1);
  assert.equal(by.nudge.turns, 2);
  assert.deepEqual(by.nudge.said.sort(), ["failed ×1", "not_yet ×1"]);
  assert.equal(by.fd.medianMs, 8000, "a step's own time, not what it waited on");
  assert.equal(by.decide.runs, 1);
  assert.equal(by.triage.said[0], "tex ×1");
  assert.equal(by.send, undefined, "the Worker's delivery is not a run of its own");
  assert.equal(runOf({ kind: "step", step: "timing", name: "model" }), null);
  const never = t.neverRan.map((n) => n.node);
  assert.ok(never.includes("reflect") && never.includes("router"));
  assert.ok(t.neverRan.find((n) => n.node === "router").off);
  assert.ok(!never.includes("nudge"));

  // Through the chats this person can probe, over the window asked for, read a page at a time.
  const asked = [];
  const ledger = {
    read: async (name, options) => {
      asked.push({ name, ...options });
      return { entries: options.after ? entries.slice(5) : entries.slice(0, 5), ...(options.after ? {} : { next: 5 }) };
    },
  };
  const page = { status: "ok", workspaceId: "ws_mine", timeZone: "UTC", chats: [] };
  const answer = await nodeStatsAnswer({}, page, { days: 90 }, { ledgerOf: () => ledger, now: 100 * 86_400_000 });
  assert.equal(answer.days, 30, "at most 30 days");
  assert.equal(asked[0].since, 70 * 86_400_000);
  assert.equal(asked.length, 2, "paged until the window's end");
  assert.equal(answer.nodes.find((n) => n.node === "nudge").runs, 2);
});

test("a failed nudge or reflect says where and why", () => {
  const out = failedAt("model", new TypeError("cannot read properties of undefined (reading 'put')"));
  assert.deepEqual(out, { outcome: "failed", where: "model", error: "TypeError", why: "cannot read properties of undefined (reading 'put')" });
  assert.equal(failedAt("x", new Error("y".repeat(500))).why.length, 200);
  assert.deepEqual(failedAt("x", "thrown string"), { outcome: "failed", where: "x", error: "Error" });
  // The fields fit the steps' contracts (texConfig.json outSchema), or the runner would fail the step.
  for (const id of ["nudge", "reflect"]) {
    const names = TEX_CONFIG.nodes.find((n) => n.id === id).outSchema.map((f) => f.name);
    for (const k of ["outcome", "where", "error", "why", "model"]) assert.ok(names.includes(k), `${id} outSchema names ${k}`);
  }
});

test("a step whose wire matched but which logged no run says so, naming what its source said", () => {
  const steps = [{ node: "triage", out: '{"to":"judge"}', ms: 0, ok: true }];
  const rows = [{ id: "t1", who: "You", text: "hi", at: 1 }, { id: "t1r", reply: "t1", who: "Tex", text: "hey", at: 2, ms: 1, steps }];
  const decide = runCard({ rows, msgId: "t1", graph: TEX_CONFIG }).notFired.find((n) => n.node === "decide");
  assert.match(decide.why, /triage ran and said \[judge\].*logged no run: the code did not run it though the config says it does/);
});

test("Triage's wires follow where it sends a text: the judge to Decide, a lone text to the Queue", () => {
  const into = (to) => TEX_CONFIG.edges.find((e) => e.from === "triage" && e.to === to).when;
  assert.deepEqual(into("decide"), ["judge", "running"]);
  assert.deepEqual(into("lanes"), ["tex"]);
});
