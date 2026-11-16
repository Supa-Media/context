/**
 * `tex_dev` `sandbox` shaped for an AI (`src/texDev/sandbox.js`; Dev2, 2026-11-16: an AI sends test texts through the
 * MCP, sees after the run which nodes fired and which did not, what each did and how long it took, and tries changes
 * against each other). Proven over a fake of the Lab's own route: the run card is only what the rows' logged steps
 * show, the steps that did not run are read from the config and the log side by side, a step is read whole with
 * Replay's own reader through the test chat's own history file, and nothing waits longer than it says.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *   notFiredOf() ignoring `on: false`                 "the card says which steps did not run and why" fails
 *   notFiredOf() matching every wire                  "the card says which steps did not run and why" fails (reviewer listed as matched)
 *   waitCard() without its deadline                   "a run still going answers what runs now" hangs, then fails
 *   step() reading the real ledger (ledgerOf)          "a step is read whole through the test chat's own history" fails
 *   open() answering every row                         "open answers the last rows only" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardDiff, compactRow, createSandboxActions, notFiredOf, runCard } from "../src/texDev/sandbox.js";
import { TEX_CONFIG } from "../src/agent/texConfig.js";

const GRAPH = { nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges };
const SB = "0123456789abcdef";
const T0 = Date.UTC(2026, 10, 16, 14, 0, 0);
const PAGE = { status: "ok", workspaceId: "ws_mine", timeZone: "America/New_York", chats: [] };

const steps = [
  { node: "text", out: '{"outcome":"queued"}', ms: 0, ok: true },
  { node: "triage", out: '{"to":"tex"}', ms: 0, ok: true },
  { node: "tools", out: '{"failed":true,"chars":0}', ms: 239, ok: true },
  { node: "fd", out: '{"when":["drafted"],"model":"anthropic/claude-haiku-5-5"}', ms: 12_148, ok: true },
  { node: "fd", out: '{"when":["done"]}', ms: 96, ok: true },
  { node: "checks", out: '{"when":["done"]}', ms: 96, ok: true },
  { node: "send", out: '{"when":["sent","threads"]}', ms: 0, ok: true },
  { node: "classifier", out: '{"filed":1}', ms: 1_212, ok: true },
];

const chatRows = (n = 30) => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, who: i % 3 === 2 ? "Tex" : "You", text: `real text ${i + 1}`, at: T0 - (n - i) * 60_000, prod: true }));
const sentRow = { id: "t1", who: "You", text: "what's on friday again?", at: T0, prod: false, steps: steps.slice(0, 3) };
const replyRow = { id: "t1r", reply: "t1", who: "Tex", text: "Friday: Pay Day.", at: T0 + 15_600, prod: false, ms: 15_072, steps };

test("the card says which steps did not run and why, from the config and the log side by side", () => {
  const card = runCard({ rows: [...chatRows(3), sentRow, replyRow], msgId: "t1", graph: GRAPH });
  assert.equal(card.status, "done");
  assert.deepEqual(card.tex, ["Friday: Pay Day."]);
  assert.equal(card.time.totalMs, 15_072);
  assert.equal(card.time.firstTextMs, 15_600);
  assert.deepEqual(card.fired.map((s) => s.node), steps.map((s) => s.node), "every step in the order it ran, repeats kept");
  assert.equal(card.slowest[0], "fd 12 s");
  assert.deepEqual(card.failed, [{ n: 3, node: "tools", why: "failed: true" }], "a tool that failed inside is a failure though its step ended ok");
  const why = Object.fromEntries(card.notFired.map((n) => [n.node, n.why]));
  assert.equal(why.router, "off in this config");
  assert.match(why.reviewer, /checks said \[done\], the wait wire wants \[report, routine\]/);
  assert.match(why.advisor, /fd may call it \(when stuck\) and did not/);
  assert.equal(why.checkin, undefined, "a trigger of its own is never 'did not run' for a text");
  assert.equal(why.dream, undefined);
  assert.ok(!card.notFired.some((n) => n.node === "fd"), "a step that ran is never listed");
});

test("a card for a run still going says what runs now and lists no steps as not run", () => {
  const card = runCard({ rows: [sentRow], msgId: "t1", graph: GRAPH, running: { msgId: "t1", node: "tools" } });
  assert.equal(card.status, "running");
  assert.equal(card.runningNow, "tools");
  assert.equal(card.notFired, "after it finishes");
  assert.match(runCard({ rows: [], msgId: "nope", graph: GRAPH }).error, /no row nope/);
});

test("the diff names Tex's words, the times, steps only in one and each changed step", () => {
  const a = runCard({ rows: [sentRow, replyRow], msgId: "t1", graph: GRAPH });
  const slower = { ...replyRow, text: "Friday: Pay Day and a haircut.", ms: 9_000, steps: [...steps.filter((s) => s.node !== "classifier"), { node: "advisor", out: '{"advice":"check the calendar"}', ms: 4_000, ok: true }] };
  const b = runCard({ rows: [sentRow, slower], msgId: "t1", graph: GRAPH });
  const d = cardDiff(a, b);
  assert.deepEqual(d.tex, { before: ["Friday: Pay Day."], after: ["Friday: Pay Day and a haircut."] });
  assert.equal(d.totalMs, "15072 → 9000");
  assert.deepEqual(d.onlyBefore, ["classifier"]);
  assert.deepEqual(d.onlyAfter, ["advisor"]);
  assert.equal(cardDiff(a, a).steps.length, 0, "the same run has no changed steps");
  assert.equal(cardDiff(a, a).tex, "same words");
});

/** A fake of the Lab's route: one test chat, its rows, a run that finishes after `polls` looks, and its history file. */
function fakeRoute({ polls = 2, entries = [], rows = chatRows(300) } = {}) {
  const calls = [];
  let looks = 0;
  let state = { rows: [...rows], running: null, versionId: "main" };
  const route = async (body) => {
    calls.push(body);
    const ok = (answer) => ({ ok: true, status: 200, answer });
    switch (body.op) {
      case "open":
        state.versionId = body.versionId ?? "main";
        return ok({ sandboxId: SB, people: [{ handle: "", name: "You" }], rows: state.rows });
      case "about":
        return ok({ source: "maya", kind: "1:1", chat: "me", versionId: state.versionId, people: [], rows: state.rows.length, testRows: 0 });
      case "use":
        state.versionId = body.versionId;
        return ok({ versionId: body.versionId });
      case "send":
      case "retry":
        if (body.op === "retry") state.rows = state.rows.filter((r) => r.id !== "t1" && r.reply !== "t1");
        state.rows.push({ ...sentRow });
        state.running = { msgId: "t1", node: "fd" };
        looks = 0;
        return ok({ msgId: "t1" });
      case "get":
        looks += 1;
        if (state.running && looks > polls) {
          state.running = null;
          state.rows.push({ ...replyRow });
        }
        return ok({ rows: state.rows, writes: [], running: state.running });
      case "read": {
        const o = body.options ?? {};
        return ok({ entries: entries.filter((e) => (!o.kinds || o.kinds.includes(e.kind)) && (o.since == null || e.at >= o.since)).map((e, i) => ({ v: 1, seq: i + 1, ...e })) });
      }
      default:
        return { ok: false, status: 400, answer: { error: `no op ${body.op}` } };
    }
  };
  return { route, calls, state };
}

const actions = (r, extra = {}) => {
  let clock = 0;
  const slept = [];
  const sandbox = createSandboxActions({
    route: r.route,
    graphOf: async () => ({ graph: GRAPH }),
    page: async () => ({ page: PAGE }),
    env: {},
    origin: "https://context.example",
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...extra,
  });
  return { sandbox, slept };
};

test("open answers the last rows only, with the total", async () => {
  const r = fakeRoute();
  const { sandbox } = actions(r);
  const opened = await sandbox({ op: "open", source: "maya" });
  assert.equal(opened.total, 300);
  assert.equal(opened.last.length, 10);
  assert.equal(opened.last.at(-1).id, "m300");
  assert.equal((await sandbox({ op: "open", source: "maya", last: 2 })).last.length, 2);
  assert.equal(opened.link, `https://context.example/lab?sandbox=${SB}`, "the person follows it live in the Lab");
  assert.equal(r.calls.find((c) => c.op === "open").by, "AI", "the Lab lists who opened it");
  const page = await sandbox({ op: "rows", sandboxId: SB, before: "m291", limit: 5 });
  assert.deepEqual(page.rows.map((x) => x.id), ["m286", "m287", "m288", "m289", "m290"]);
  assert.equal(page.before, "m286");
  assert.deepEqual(compactRow({ id: "x", who: "You", text: "hi", prod: true, eid: "e" }), { id: "x", who: "You", text: "hi", real: true });
});

test("send waits for the run and answers its card; wait 0 answers at once; a run still going answers what runs now", async () => {
  const r = fakeRoute({ polls: 2 });
  const { sandbox, slept } = actions(r);
  const card = await sandbox({ op: "send", sandboxId: SB, text: "what's on friday again?" });
  assert.equal(card.status, "done");
  assert.equal(slept.length, 2, "it looked until the run was done, then stopped");
  const quick = await sandbox({ op: "send", sandboxId: SB, text: "hi", wait: 0 });
  assert.deepEqual(Object.keys(quick).sort(), ["msgId", "next", "status"]);
  const stuck = fakeRoute({ polls: 1e9 });
  const s2 = actions(stuck);
  const going = await s2.sandbox({ op: "send", sandboxId: SB, text: "hi", wait: 3 });
  assert.equal(going.status, "running");
  assert.equal(going.runningNow, "fd");
  assert.ok(s2.slept.reduce((a, b) => a + b, 0) <= 4_500, "never waits past what it said");
  const capped = actions(fakeRoute({ polls: 1e9 }));
  await capped.sandbox({ op: "send", sandboxId: SB, text: "hi", wait: 600 });
  assert.ok(capped.slept.reduce((a, b) => a + b, 0) <= 51_500, "at most 50 seconds, whatever is asked");
  assert.match((await sandbox({ op: "send", sandboxId: "nope", text: "x" })).error, /sandboxId/);
});

test("a step is read whole through the test chat's own history, with Replay's reader", async () => {
  const entries = [
    { id: "a1", at: T0, kind: "text", eid: "e1", from: { kind: "person" }, text: "what's on friday again?" },
    { id: "n1", at: T0 + 13_000, kind: "step", step: "node", name: "fd", turn: "lt1", ok: true, ms: 12_148, input: { asked: "friday" }, output: { when: ["drafted"] } },
    { id: "th", at: T0 + 12_000, kind: "thinking", turn: "lt1", ms: 800, text: "Check the calendar for Friday." },
    { id: "s1", at: T0 + 15_500, kind: "text", turn: "lt1", from: { kind: "tex" }, text: "Friday: Pay Day." },
    { id: "r1", at: T0 + 15_600, kind: "reply", turn: "lt1", ms: 15_072, text: "Friday: Pay Day.", model: "anthropic/claude-haiku-5-5" },
  ];
  const r = fakeRoute({ entries, rows: [] });
  let realLedgerRead = false;
  const { sandbox } = actions(r, { ledgerOf: () => ({ read: async () => ((realLedgerRead = true), { entries: [] }) }) });
  await sandbox({ op: "send", sandboxId: SB, text: "what's on friday again?" });
  const one = await sandbox({ op: "step", sandboxId: SB, msgId: "t1", node: "fd" });
  assert.equal(one.turn, "lt1");
  assert.deepEqual(Object.keys(one.io), ["fd"]);
  assert.ok(one.order.some((e) => e.kind === "thinking" && /calendar/.test(e.text)), "its thinking is there");
  assert.equal(one.link, undefined, "no Replay link to a real chat for a test chat");
  assert.ok(one.order.every((e) => e.name === "fd" || e.kind === "thinking" || e.kind === "tool" || e.kind === "judge"), "one step asked for answers only its own entries");
  const whole = await sandbox({ op: "step", sandboxId: SB, msgId: "t1" });
  assert.ok(whole.order.some((e) => e.kind === "reply"), "without node, the whole turn in order");
  assert.ok(r.calls.filter((c) => c.op === "read").length > 0 && !realLedgerRead, "read only through the test chat's own route");
});

test("again re-runs a text on a draft and answers both cards and the diff; try runs one text on several drafts", async () => {
  const r = fakeRoute({ polls: 0 });
  const { sandbox } = actions(r);
  await sandbox({ op: "send", sandboxId: SB, text: "what's on friday again?" });
  const again = await sandbox({ op: "again", sandboxId: SB, msgId: "t1", draft: "vabc" });
  assert.ok(r.calls.some((c) => c.op === "use" && c.versionId === "vabc"));
  assert.ok(r.calls.some((c) => c.op === "retry" && c.msgId === "t1"));
  assert.equal(again.after.status, "done");
  assert.equal(again.after.draft, "vabc");
  assert.equal(again.diff.tex, "same words");
  assert.ok(Array.isArray(again.before.steps));
  const tried = await sandbox({ op: "try", text: "what's on friday again?", drafts: ["main", "vabc", "v2", "v3", "v4"] });
  assert.equal(tried.runs.length, 4, "at most four drafts at once");
  assert.deepEqual(r.calls.filter((c) => c.op === "open").map((c) => c.versionId), ["main", "vabc", "v2", "v3"]);
  assert.ok(tried.runs[1].vsFirst);
});

test("the graph's own steps: notFiredOf never lists a step the log shows", () => {
  const all = GRAPH.nodes.map((n) => ({ node: n.id, out: "{}", ms: 1, ok: true }));
  assert.deepEqual(notFiredOf(GRAPH, all), []);
});

test("replay sets a real text's production run beside the same words re-run, from what the production log shows", async () => {
  const real = [
    { id: "x1", at: T0, kind: "text", eid: "e9", from: { kind: "person" }, text: "what's on friday again?" },
    { id: "x2", at: T0 + 300, kind: "step", step: { name: "triage", output: { to: "tex" }, ms: 5, ok: true } },
    { id: "x3", at: T0 + 9_000, kind: "step", step: "node", name: "fd", turn: "pt1", ok: true, ms: 8_000, output: { when: ["done"] } },
    { id: "x4", at: T0 + 9_100, kind: "step", step: "node", name: "send", turn: "pt1", ok: true, ms: 0, output: { when: ["sent"] } },
    { id: "x5", at: T0 + 9_200, kind: "text", turn: "pt1", from: { kind: "tex" }, text: "Friday: nothing." },
    { id: "x6", at: T0 + 9_300, kind: "reply", turn: "pt1", ms: 9_300, text: "Friday: nothing.", version: { code: "abc1234" } },
  ].map((e, i) => ({ v: 1, seq: i + 1, ...e }));
  const ledger = { read: async (_n, o = {}) => ({ entries: real.filter((e) => (!o.kinds || o.kinds.includes(e.kind)) && (o.since == null || e.at >= o.since) && (o.until == null || e.at < o.until)) }) };
  const r = fakeRoute({ polls: 0, rows: [] });
  const { sandbox } = actions(r, { realChat: async () => ({ ledger, name: "texts" }) });
  const out = await sandbox({ op: "replay", text: "e9", draft: "vabc" });
  assert.deepEqual(out.production.fired.map((s) => s.node), ["triage", "fd", "send"]);
  assert.deepEqual(out.production.tex, ["Friday: nothing."]);
  assert.equal(out.production.turn, "pt1");
  assert.match(out.production.notFired, /not worked out/, "never a guess about a graph it did not run on");
  const opened = r.calls.find((c) => c.op === "open");
  assert.deepEqual([opened.source, opened.chatId, opened.base, opened.versionId], ["chat", "me", "e9", "vabc"]);
  assert.equal(r.calls.find((c) => c.op === "send").text, "what's on friday again?");
  assert.deepEqual(out.diff.tex, { before: ["Friday: nothing."], after: ["Friday: Pay Day."] });
  assert.match((await sandbox({ op: "replay", text: "nope" })).error, /no text nope/);
});

test("a card names what sent each Tex text, the steps behind it, a job's later texts and how to read a sandbox page", () => {
  const rows = [
    { ...sentRow, line: { name: "photon", inMs: 850 } },
    { ...replyRow, from: "fd", cause: ["s1", "s4"], line: { name: "photon", inMs: 0, outMs: 900 }, steps: steps.map((s, i) => ({ ...s, id: `s${i}`, ...(i ? { parent: `s${i - 1}` } : {}) })) },
    { id: "j1", who: "Tex", text: "Found the table.", at: T0 + 60_000, prod: false, from: "job", cause: ["s9"] },
    { id: "t2", who: "You", text: "next", at: T0 + 90_000, prod: false },
    { id: "j2", who: "Tex", text: "not this one's", at: T0 + 95_000, prod: false, from: "job" },
  ];
  const card = runCard({ rows, msgId: "t1", graph: GRAPH, writes: [{ id: "w1", kind: "page", title: "Plan", by: "t1" }, { id: "w2", kind: "note", by: "t2" }] });
  assert.deepEqual(card.texSent, [{ id: "t1r", from: "fd", cause: ["s1", "s4"], lineOutMs: 900 }, { id: "j1", from: "job", cause: ["s9"] }]);
  assert.deepEqual(card.jobTexts.map((j) => j.id), ["j1"], "only this text's job texts, before the next test text");
  assert.deepEqual(card.time.lineMs, { in: 850, out: 900 });
  assert.equal(card.fired[1].id, "s1");
  assert.equal(card.fired[1].parent, "s0");
  assert.deepEqual(card.writes.map((w) => w.id), ["w1"]);
  assert.match(card.writes[0].read, /page \{ sandboxId, id: "w1" \}/);
});
