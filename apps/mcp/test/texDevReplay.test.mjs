/**
 * `tex_dev` Replay (`packages/lab/gateway/texDev/replay.js`; Dev2, 2026-11-15: anything that can be done or seen inside the Tex Lab can
 * be done or seen through the MCP). Each action is proven against the Lab's own Replay code (`replay.generated.js`,
 * bundled from `packages/lab/app/engine/replayEntry.ts`) run on the same chat history: the answer is what
 * the Lab shows, read the way the Lab reads it, and only what the log shows ran.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-15):
 *   momentsAnswer() without `loggedMoments`                    "moments are the Lab's moments" fails (the moment from before full logging shows)
 *   momentsAnswer() without the span read (lines only)         "moments are the Lab's moments" fails (the judge's calls are gone)
 *   turnWorld() reading `world.all` instead of the moment's    "a turn carries the moment's judgings" fails (no decide step)
 *     Worker steps (`momentTurnEntries`)
 *   promptAnswer() taking a module's words without `wordsOf`   "the prompt's words come only from the catalogue" fails
 *     (first row for the module id, fingerprint unchecked)
 *   jobWorkOf() without each run turn's own span read          "a job's runs are JobRuns'" fails (the report's review is missing)
 *   turnsOf() back to every reply read                         "turns lists 20 unless limit" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as R from "../../../packages/lab/gateway/texDev/replay.generated.js";
import { createTexDev } from "../../../packages/lab/gateway/texDev/tool.js";
import { guideText } from "../../../packages/lab/gateway/texDev/guide.js";
import { turnsOf } from "../../../packages/lab/gateway/texDev/probe.js";
import { jobsAnswer, linkAnswer, mineAnswer, momentsAnswer, promptAnswer, turnAnswer } from "../../../packages/lab/gateway/texDev/replay.js";

const ORIGIN = "https://context.example";
const PAGE = { status: "ok", workspaceId: "ws_mine", timeZone: "America/New_York", chats: [{ key: "g1", name: "Dinner club", people: 3 }] };
const T0 = Date.UTC(2026, 10, 14, 15, 0, 0);
const H = 3_600_000;
const CHECK_IN = "(Not a text from them. This was your own check-in: see if anything needs saying.)";

/** A ledger read as `texStore/ledger.js` reads: seq order, kinds, since/until, before/after, limit, jobs, job, ids. */
function fakeLedger(entries) {
  const all = entries.map((e, i) => ({ v: 1, ...e, seq: i + 1 }));
  const reads = [];
  return {
    reads,
    async read(_chat, { kinds = null, since = null, until = null, before = null, after = null, limit = 5_000, jobs = true, job = null, ids = null } = {}) {
      reads.push({ kinds, since, until, before, job });
      let out = all.filter(
        (e) =>
          (kinds ? kinds.includes(e.kind) : true) &&
          (since === null || e.at >= since) &&
          (until === null || e.at < until) &&
          (jobs === false ? e.jobId === undefined : true) &&
          (job === null ? true : e.jobId === job || (e.kind === "job" && e.job === job)) &&
          (ids === null ? true : ids.includes(e.id)),
      );
      if (before !== null) out = out.filter((e) => e.seq < before).reverse();
      else if (after !== null) out = out.filter((e) => e.seq > after);
      const more = out.length > limit;
      out = out.slice(0, limit);
      return { entries: out, ...(more ? (before !== null ? { before: out.at(-1).seq } : { next: out.at(-1).seq }) : {}) };
    },
  };
}

const modules = [
  { id: "stable/text/core", n: 22, h: "aaaaaaaa" },
  { id: "context/aboutMe", n: 50, h: "bbbbbbbb" },
  { id: "context/progress", n: 5, h: "cccccccc" },
];

/** One 1:1 chat: two texts one turn answers (with the Worker's judgings and a job), a check-in, a quiet look, an old text. */
function chatEntries(code = "abc1234def") {
  return [
    { id: "old", at: Date.UTC(2026, 10, 12, 12), kind: "text", eid: "e0", from: { kind: "person" }, text: "an old text" },
    { id: "a1", at: T0, kind: "text", eid: "e1", from: { kind: "person" }, text: "book the table" },
    { id: "w1", at: T0 + 400, kind: "step", step: { name: "decide", of: "waiting", ok: true, ms: 300, input: { candidates: ["e1"] }, output: { act: "answer" } } },
    { id: "d1", at: T0 + 500, kind: "step", step: "door", turn: "t1", ok: true, ms: 60, input: { covers: ["e1", "e2"] }, output: { effort: "low" } },
    { id: "th1", at: T0 + 1_500, kind: "thinking", turn: "t1", ms: 800, text: "They want Friday." },
    { id: "a2", at: T0 + 2_000, kind: "text", eid: "e2", from: { kind: "person" }, text: "for 4 people" },
    { id: "w2", at: T0 + 2_300, kind: "step", step: { name: "decide", of: "running", ok: true, ms: 200, input: { newest: "e2" }, output: { act: "answer", midTurn: "fold" } } },
    { id: "jm", at: T0 + 2_400, kind: "judge", by: "moment", verdict: "respond", event: "e2", ms: 250, running: true, midTurn: "fold" },
    { id: "to1", at: T0 + 4_600, kind: "tool", turn: "t1", name: "browse", ok: false, ms: 3_000, args: { url: "https://example.com" }, reason: "timed out" },
    { id: "to2", at: T0 + 4_700, kind: "tool", turn: "t1", name: "fetch", ok: true, ms: 40, args: { id: "projects/dinner.md" }, result: "# Dinner" },
    { id: "rv1", at: T0 + 5_000, kind: "judge", turn: "t1", by: "review", went: true, ms: 400, model: "haiku-5-5", draft: "Booked for 4 at 7" },
    { id: "cl1", at: T0 + 5_200, kind: "step", step: "classifier", turn: "t1", ok: true, ms: 100, input: "for 4 people", output: { threads: ["dinner"] } },
    { id: "jb", at: T0 + 5_300, kind: "job", turn: "t1", job: "jb1", title: "Find a table", state: "keep_going", advice: "try another site" },
    { id: "s1", at: T0 + 6_000, kind: "text", turn: "t1", from: { kind: "tex" }, text: "Booked for 4 at 7", covers: ["e1", "e2"] },
    {
      id: "r1",
      at: T0 + 6_100,
      kind: "reply",
      turn: "t1",
      ms: 5_600,
      model: "anthropic/claude-haiku-5-5",
      text: "Booked for 4 at 7",
      version: { code, setup: "5e7a1b" },
      timing: {
        waitMs: 400,
        replyMs: 5_600,
        rounds: [
          { at: 700, ms: 800, model: "anthropic/claude-haiku-5-5", input: 100, output: 20, prompt: { modules, inputs: { at: T0, timeZone: "America/New_York", model: "anthropic/claude-haiku-5-5", history: 3 } } },
          { at: 2_000, ms: 500, model: "anthropic/claude-haiku-5-5", prompt: { modules } },
        ],
        tools: [{ at: 4_000, ms: 3_000, name: "browse" }],
      },
    },
    // The job's own run, an hour on: its work carries `jobId`; its review does not.
    { id: "jr-t", at: T0 + H, kind: "thinking", turn: "jr1", jobId: "jb1", ms: 300, text: "Try the second site." },
    { id: "jr-tool", at: T0 + H + 100, kind: "tool", turn: "jr1", jobId: "jb1", name: "browse", ok: true, ms: 900, args: { url: "https://example.org" }, result: "a table at 8" },
    { id: "jr-rv", at: T0 + H + 1_200, kind: "judge", turn: "jr1", by: "review", went: true, ms: 200, draft: "Found one at 8" },
    { id: "jr-job", at: T0 + H + 1_300, kind: "job", turn: "jr1", job: "jb1", state: "done", advice: "found one", report: "Found a table at 8" },
    { id: "jr-r", at: T0 + H + 1_400, kind: "reply", turn: "jr1", jobId: "jb1", ms: 1_400, text: "Found a table at 8", model: "anthropic/claude-haiku-5-5" },
    // A check-in that texted, and one that looked and sent nothing.
    { id: "ck1-t", at: T0 + 2 * H - 9_000, kind: "thinking", turn: "ck1", ms: 600, text: "Anything due?" },
    { id: "ck1", at: T0 + 2 * H, kind: "note", turn: "ck1", about: CHECK_IN, text: "Morning! Anything for today?" },
    { id: "ck2-t", at: T0 + 3 * H, kind: "thinking", turn: "ck2", ms: 500, text: "Nothing worth a text." },
    { id: "ck2-r", at: T0 + 3 * H + 100, kind: "reply", turn: "ck2", text: "" },
    { id: "a3", at: T0 + 4 * H, kind: "text", eid: "e3", from: { kind: "person" }, text: "thanks" },
  ];
}

/** What the Lab holds for this chat once it has read it (`useMine.ts`): its lines with no job's work, and every detail. */
function labView(entries, group = false) {
  const seen = entries.filter((e) => R.LINE_KINDS.includes(e.kind) && e.jobId === undefined).map((e, i) => ({ ...e }));
  const detail = entries.filter((e) => R.DETAIL_KINDS.includes(e.kind));
  const all = [...seen, ...detail];
  const { texts, lines } = R.linesOf(seen, group);
  return { seen, all, texts, lines, moments: R.loggedMoments(R.momentsOf(lines, all)) };
}

const withSeq = (entries) => entries.map((e, i) => ({ v: 1, ...e, seq: i + 1 }));
const deps = (ledger, extra = {}) => ({ ledgerOf: () => ledger, origin: ORIGIN, ...extra });

test("moments are the Lab's moments: every one, check-ins and quiet looks too, newest first, with the panel's facts", async () => {
  const entries = chatEntries();
  const lab = labView(withSeq(entries));
  const answer = await momentsAnswer({}, PAGE, {}, deps(fakeLedger(entries)));
  assert.deepEqual(answer.moments.map((m) => m.moment), lab.moments.map((m) => m.id).reverse());
  assert.ok(!answer.moments.some((m) => m.moment === "old"), "a moment from before full logging is left out, as the Lab leaves it out");
  const first = answer.moments.find((m) => m.moment === "a1");
  const want = lab.moments.find((m) => m.id === "a1");
  assert.equal(first.behind, 1);
  assert.equal(first.turns, want.turns.length);
  assert.equal(first.toLastSendMs, want.of);
  assert.deepEqual(first.judge.map((j) => j.said), want.lanes.Judge.map((b) => b.label));
  assert.equal(first.judge.length, 3, "two Worker decides and one group-style judging");
  assert.deepEqual(first.jobs, [{ id: "jb1", title: "Find a table" }]);
  assert.equal(first.turnRuns[0].waitedMs, 400);
  assert.equal(first.link, `${ORIGIN}/lab?moment=a1`);
  assert.equal(answer.moments.find((m) => m.moment === "ck1").from, "Check-in");
  const quiet = answer.moments.find((m) => m.moment === "ck:ck2");
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.text, R.QUIET_WORDS);
});

test("moments page back with before, and show 20 unless limit", async () => {
  const entries = chatEntries();
  const ledger = fakeLedger(entries);
  const two = await momentsAnswer({}, PAGE, { limit: 2 }, deps(ledger));
  assert.equal(two.moments.length, 2);
  assert.ok(Number.isSafeInteger(two.before));
  const rest = await momentsAnswer({}, PAGE, { before: two.before }, deps(ledger));
  const lab = labView(withSeq(entries));
  assert.deepEqual([...two.moments, ...rest.moments].map((m) => m.moment), lab.moments.map((m) => m.id).reverse());
  assert.equal(rest.before, undefined);
});

test("one moment whole: its lines, the timeline's lanes and its rows by step, as the Lab draws them", async () => {
  const entries = chatEntries();
  const lab = labView(withSeq(entries));
  const answer = await momentsAnswer({}, PAGE, { moment: "a1" }, deps(fakeLedger(entries)));
  const m = lab.moments.find((x) => x.id === "a1");
  assert.deepEqual(answer.lines.map((l) => l.id), m.lines.map((l) => l.id));
  assert.deepEqual(answer.lanes.Judge.map((b) => [b.startMs, b.endMs, b.label]), m.lanes.Judge.map((b) => [b.start, b.end, b.label]));
  assert.deepEqual(answer.lanes.Turn.map((b) => [b.kind, b.startMs, b.endMs]), m.lanes.Turn.map((b) => [b.kind, b.start, b.end]));
  assert.deepEqual(answer.steps.map((r) => [r.step, r.bars.map((b) => b.ran)]), R.stepRows(m, lab.all).map((r) => [r.id, r.bars.map((b) => b.label)]));
  assert.ok(answer.steps.some((r) => r.step === "decide"), "the Worker's judging is a step on the timeline");
  assert.match((await momentsAnswer({}, PAGE, { moment: "nope" }, deps(fakeLedger(entries)))).error, /no moment nope/);
});

test("a turn carries the moment's judgings, its real time per step, what each step got and gave, its jobs and reads", async () => {
  const entries = chatEntries();
  const lab = labView(withSeq(entries));
  const answer = await turnAnswer({}, PAGE, { turn: "t1" }, deps(fakeLedger(entries)));
  const m = lab.moments.find((x) => x.id === "a1");
  const shown = R.turnShown(m, lab.lines, lab.all, "t1");
  assert.equal(answer.moment, "a1");
  assert.equal(answer.real.waitedMs, shown.times.reply);
  assert.deepEqual(Object.fromEntries(answer.real.nodes.map((n) => [n.node, n.ms])), shown.times.ms);
  assert.ok(answer.real.nodes.some((n) => n.node === "decide"), "the Worker's decide is the turn's Decide");
  assert.deepEqual(Object.keys(answer.io).sort(), Object.keys(shown.io).sort());
  assert.deepEqual(answer.io.decide.map((l) => l.k), shown.io.decide.map((l) => l.k));
  assert.ok(answer.order.some((e) => e.label === "step decide"));
  assert.ok(answer.order.every((e, i) => e.n === i + 1 && Number.isFinite(e.tPlusMs)));
  assert.deepEqual(answer.jobs, [{ id: "jb1", title: "Find a table" }]);
  assert.deepEqual(answer.reads, ["projects/dinner.md"]);
  assert.equal(answer.prompt.modules, 3);
  // The reply's timing once: in brief in the summary, and the reply in the order says where it is.
  assert.equal(answer.order.find((e) => e.label === "reply").timing, "in summary.timing");
  assert.deepEqual(answer.summary.timing.rounds[0].prompt, { modules: 3, chars: 77 });
  // A round's kept words (`turnTiming.js`) stay out of the full timing too: `prompt` is the action that shows them.
  const reply = entries.find((e) => e.kind === "reply" && e.timing?.rounds?.[0]?.prompt);
  reply.timing.rounds[0].prompt.words = { [modules[0].h]: "kept words" };
  const full = await turnAnswer({}, PAGE, { turn: "t1", full: true }, deps(fakeLedger(entries)));
  assert.deepEqual(full.summary.timing.rounds[0].prompt.modules, modules);
  assert.equal(full.summary.timing.rounds[0].prompt.words, undefined);
  const one = await turnAnswer({}, PAGE, { turn: "t1", node: "fd" }, deps(fakeLedger(entries)));
  assert.deepEqual(Object.keys(one.io), ["fd"]);
});

test("a turn by its moment: a check-in plays from its own start step", async () => {
  const entries = chatEntries();
  const answer = await turnAnswer({}, PAGE, { moment: "ck1" }, deps(fakeLedger(entries)));
  assert.equal(answer.turn, "ck1");
  assert.deepEqual(answer.io.checkin, [{ k: "Started", v: CHECK_IN }]);
  // A quiet look has no text of its own: it is found by its turn, as the Lab's address names it.
  const quiet = await turnAnswer({}, PAGE, { moment: "ck:ck2" }, deps(fakeLedger(entries)));
  assert.equal(quiet.turn, "ck2");
  assert.deepEqual(quiet.real.nodes.map((n) => n.node), ["fd"]);
  assert.equal((await momentsAnswer({}, PAGE, { moment: "ck:ck2" }, deps(fakeLedger(entries)))).text, R.QUIET_WORDS);
  assert.match((await turnAnswer({}, PAGE, {}, deps(fakeLedger(entries)))).error, /name the turn/);
});

test("the prompt's words come only from the catalogue at the turn's commit, matched by fingerprint", async () => {
  const code = "1111111aaaa";
  const asked = [];
  const catalogue = { v: 2, modules: { aaaaaaaa: { id: "stable/text/core", kinds: ["text"], n: 22, at: [0, 1] }, cccccccc: { id: "context/other", kinds: ["text"], n: 5, at: [1] }, dddddddd: { id: "context/aboutMe", kinds: ["text"], n: 9, at: [1] } }, lines: ["You are Tex.", "Be brief."] };
  const fetch = async (url) => (asked.push(url), new Response(JSON.stringify(catalogue)));
  const answer = await promptAnswer({}, PAGE, { turn: "t1" }, deps(fakeLedger(chatEntries(code)), { fetch }));
  assert.deepEqual(asked, [`https://raw.githubusercontent.com/Supa-Media/context/${code}/packages/lab/app/promptCatalog.generated.json`]);
  const [r1, r2] = answer.rounds;
  assert.equal(r1.modules[0].words, R.wordsOf(catalogue, modules[0]));
  assert.equal(r1.modules[0].words, "You are Tex.\nBe brief.");
  assert.equal(r1.modules[1].words, null);
  assert.match(r1.modules[1].why, /their own words/);
  // Another version of the same module (another fingerprint), or a fingerprint the catalogue holds for another module: not the words that ran.
  assert.equal(r1.modules[2].words, null);
  assert.deepEqual(answer.notInCatalogue, ["context/aboutMe", "context/progress"]);
  assert.match(r2.same, /round 1/);
  const page = await promptAnswer({}, PAGE, { turn: "t1", module: "stable/text/core", from: 4, limit: 5 }, deps(fakeLedger(chatEntries(code)), { fetch }));
  assert.deepEqual([page.words, page.more], ["are T", { from: 9 }]);
  const none = await promptAnswer({}, PAGE, { turn: "t1" }, deps(fakeLedger(chatEntries("2222222bbbb")), { fetch: async () => new Response("", { status: 404 }) }));
  assert.ok(none.rounds[0].modules.every((m) => m.words === null));
  assert.match(none.catalogue, /none read/);
  assert.match((await promptAnswer({}, PAGE, { turn: "t1", node: "reviewer" }, deps(fakeLedger(chatEntries(code)), { fetch }))).error, /only the front door/);
});

test("a job's runs are JobRuns': each run's check, advice, tools, thinking and its report's other steps", async () => {
  const entries = chatEntries();
  const lab = R.jobWork(withSeq(entries).filter((e) => R.JOB_KINDS.includes(e.kind)), "jb1");
  const answer = await jobsAnswer({}, PAGE, { job: "jb1" }, deps(fakeLedger(entries)));
  const [job] = answer.jobs;
  assert.equal(job.title, lab.title);
  assert.equal(job.runs, lab.runs.length);
  assert.deepEqual(job.list.map((r) => [r.turn, r.check, r.advice]), lab.runs.map((r) => [r.turn, R.stateWords(r.state), r.advice]));
  const report = job.list.find((r) => r.turn === "jr1");
  assert.equal(report.run, "report");
  assert.deepEqual(report.tools.map((t) => t.name), ["browse"]);
  assert.ok(report.steps.some((s) => s.what === "judge"), "the report turn's review, which carries no job id");
  const byTurn = await jobsAnswer({}, PAGE, { turn: "t1" }, deps(fakeLedger(entries)));
  assert.deepEqual(byTurn.jobs.map((j) => j.job), ["jb1"]);
});

test("mine is the Lab's Your texts, with the notes each turn read and a run config for the ones picked", async () => {
  const entries = chatEntries();
  const lab = labView(withSeq(entries));
  const session = { workspaces: [{ kind: "personal", role: "owner", slug: "mine" }] };
  const answer = await mineAnswer({}, PAGE, { pick: ["a1"] }, deps(fakeLedger(entries), { session }));
  assert.deepEqual(answer.texts.map((t) => t.id), lab.texts.map((t) => t.id));
  const a1 = answer.texts.find((t) => t.id === "a1");
  assert.equal(a1.then.text, "Booked for 4 at 7");
  assert.equal(a1.then.version, "abc1234 · setup 5e7a1b");
  assert.deepEqual(a1.reads, R.readsOf(withSeq(entries), "t1"));
  assert.deepEqual(answer.runConfig.replays.map((r) => [r.id, r.reads]), [["a1", ["projects/dinner.md"]]]);
  assert.deepEqual((await mineAnswer({}, PAGE, { q: "thanks" }, deps(fakeLedger(entries), { session }))).texts.map((t) => t.id), ["a3"]);
});

test("link writes the Lab's own address: a chat and a text, a page, a draft (Replay is not a mode: an old mode=replay address opens the Lab)", async () => {
  assert.equal((await linkAnswer(PAGE, { mode: "replay", moment: "a1" }, { origin: ORIGIN })).link, `${ORIGIN}/lab${R.searchOf({ mode: "lab", view: "canvas", chat: "me", moment: "a1" })}`);
  assert.equal((await linkAnswer(PAGE, { chat: "g1", moment: "ck:ck2" }, { origin: ORIGIN })).link, `${ORIGIN}/lab?chat=g1&moment=ck%3Ack2`);
  assert.deepEqual(R.placeOf("?mode=replay&chat=g1&moment=ck%3Ack2"), { mode: "lab", view: "canvas", chat: "g1", moment: "ck:ck2" });
  assert.deepEqual(R.placeOf("?chat=g1&moment=ck%3Ack2"), { mode: "lab", view: "canvas", chat: "g1", moment: "ck:ck2" });
  assert.equal((await linkAnswer(PAGE, { page: "sim" }, { origin: ORIGIN, draft: "vabc" })).link, `${ORIGIN}/lab?v=vabc&page=sim`);
  assert.match((await linkAnswer(PAGE, { chat: "nope" }, { origin: ORIGIN })).error, /no such chat/);
  assert.match((await linkAnswer(PAGE, { page: "nowhere" }, { origin: ORIGIN })).error, /page is one of/);
  const plane = { async texDev(_t, action) { return action === "page" ? PAGE : action === "get" ? { status: "ok", rev: 1, graph: "{}" } : null; } };
  const call = createTexDev({ env: { APP_ORIGIN: ORIGIN }, session: { accessToken: "tok" }, controlPlane: plane, ledgerOf: () => fakeLedger(chatEntries()) });
  const link = JSON.parse((await call("link", { mode: "replay", moment: "a1", draft: "vabc" })).content[0].text);
  assert.equal(link.link, `${ORIGIN}/lab?v=vabc&moment=a1`);
  const moments = JSON.parse((await call("moments", { limit: 1 })).content[0].text);
  assert.equal(moments.moments[0].moment, "a3");
});

test("turns lists 20 unless limit, at most 100, and pages back from the oldest shown", async () => {
  const entries = [];
  for (let i = 0; i < 30; i += 1) {
    entries.push({ id: `p${i}`, at: T0 + i * 60_000, kind: "text", from: { kind: "person" }, text: `ask ${i}` });
    entries.push({ id: `r${i}`, at: T0 + i * 60_000 + 1_000, kind: "reply", turn: `t${i}`, ms: 900 });
  }
  const ledger = fakeLedger(entries);
  const first = await turnsOf({}, PAGE, {}, { ledgerOf: () => ledger });
  assert.equal(first.turns.length, 20);
  assert.equal(first.turns[0].turn, "t29");
  const rest = await turnsOf({}, PAGE, { before: first.before }, { ledgerOf: () => ledger });
  assert.deepEqual(rest.turns.map((t) => t.turn), Array.from({ length: 10 }, (_, i) => `t${9 - i}`));
  assert.equal((await turnsOf({}, PAGE, { limit: 500 }, { ledgerOf: () => ledger })).turns.length, 30);
});

test("the guide names Replay's actions", () => {
  const text = guideText();
  for (const action of ["moments", "turn", "prompt", "jobs", "mine", "link"]) assert.match(text, new RegExp(`- ${action} `));
});
