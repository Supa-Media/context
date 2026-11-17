import assert from "node:assert/strict";
import graphLib from "../../../../../packages/shared/src/texGraph.cjs";
import { eventEntry, ledgerObserver, nodeLog } from "../../../src/agent/ledger.js";
import { replyJudge, REVIEW_MODEL } from "../../../src/agent/replyJudge.js";
import { TEX_CONFIG } from "../../../src/agent/texConfig.js";
import { draftBridge } from "../../../src/agent/graph/draftBridge.js";
import { answerCheckNode } from "../../../src/agent/graph/nodes/answerCheck.js";

/** One part's turn on the real runner and the real Answer check, with live Tex's loop wire, and a front door whose model writes `drafts` in turn. */
async function part(drafts, notices) {
  const live = TEX_CONFIG.edges.find((e) => e.from === "answerCheck" && e.to === "fd" && e.mode === "loop");
  const node = (id) => ({ id, on: true, rounds: TEX_CONFIG.nodes.find((n) => n.id === id)?.rounds ?? 1 });
  const wire = (from, to) => ({ from, to, mode: "wait", when: ["*"] });
  const sent = [];
  const turn = { reviewedAs: null, answerChecks: { code: async (draft) => ({ notice: notices(draft), review: false }), review: async () => null } };
  const fd = async (input, io) => {
    const t = io.ctx.turn;
    const stop = t.drafts?.waiting ? await t.drafts.resume(input?.notice ?? null) : await (t.drafts = draftBridge()).start(
      (async () => {
        for (const draft of drafts) if ((await t.drafts.answerCheck(draft, {})) === null) return (t.last = draft);
      })(),
    );
    return stop.paused ? { when: ["drafted"], pending: true } : { when: ["done"], pending: false };
  };
  const graph = graphLib.createGraph(
    { nodes: [node("fd"), node("answerCheck"), node("send")], edges: [wire("fd", "answerCheck"), wire("answerCheck", "send"), live] },
    { fd, answerCheck: answerCheckNode, send: async (_x, io) => (sent.push(io.ctx.turn.last), { when: ["sent"] }) },
  );
  const { outputs } = await graph.run("fd", {}, { turn });
  return { sent, check: outputs.answerCheck };
}
import { claimCheck } from "../../../src/agent/claimCheck.js";

/** A job's part that looked things up on the web and wrote its findings out as a long wall of words, with no figures. */
const WALL = Array.from({ length: 14 }, (_, at) => `Finding ${at + 1} is that the staffing report for the week shows no rows and the sign-in still works.`).join(" ");
const web = { tools: [{ name: "search_web" }, { name: "browse" }], call: async () => ({ content: [{ type: "text", text: "results" }] }) };

/** A reviewer that lets every draft go, as the gateway answers it. */
const passing = async () => ({ text: JSON.stringify({ verdict: "pass", kind: "chat", problems: [], feedback: "" }) });

export default {
  id: "checks-step-logged",
  incident: "2026-11-17: a job's checks sent each draft back once per check and crashed the part. 2026-11-14: replaying a 1:1 turn in the Lab, Answer checks showed a bar but nothing it got or gave, and a turn whose review was skipped showed nothing for the reviewer either.",
  cause: "With the reviewer on, the code checks run inside it and wrote to the chat's record only when they sent a draft back, and a skipped review went only to the console, so a check that passed or a review that was skipped left no trace.",
  path: "1:1 text",
  async run() {
    const written = [];
    const tell = ledgerObserver({ write: (entry) => written.push(entry) }, null, { turn: "turn-replay-0001" });
    const judge = replyJudge({ setting: { model: REVIEW_MODEL }, question: "what's 17 times 23?", history: [], request: passing, log: () => {}, inner: { check: () => null }, plain: { check: () => null } });
    // A turn with no action: the plain checks run, and the review is skipped.
    assert.equal(await judge.check("391.", { messages: [], tell }), null);
    const checks = written.filter((entry) => entry.kind === "step" && entry.step === "checks");
    assert.equal(checks.length, 1, "the code checks are a step in the chat's record even when they pass");
    assert.equal(checks[0].turn, "turn-replay-0001", "under the turn they checked");
    assert.deepEqual(checks[0].output, { verdict: "let it go" }, "with whether the draft passed");
    assert.equal(checks[0].input.set, "plain", "and which checks ran");
    const skipped = written.find((entry) => entry.kind === "step" && entry.step === "reviewer");
    assert.ok(skipped, "a review skipped for a turn with no action is a step too");
    assert.equal(skipped.output.verdict, "skipped");
    // Ids and times are random digits that can hold "391" (a flake seen in CI on 2026-11-14), so they are left out.
    const kept = JSON.stringify(written.map(({ id: _id, at: _at, ...entry }) => entry));
    assert.ok(!kept.includes("391"), "never the draft's words, which are the reply entry");

    // 2026-11-15: Text them, Answer checks, Memory nudge and Reflect showed 0 s. Answer checks' run held the front
    // door's rewrite, and Text them's delivery, done by the texting Worker, was never kept, so Replay drew Text them as
    // the reply less the other steps, which fell to 0. Each run keeps its own time, and the delivery is a step.
    let clock = 0;
    const runs = [];
    const node = (id) => ({ id, on: true, rounds: 1 });
    const wire = (from, to, mode = "wait") => ({ from, to, mode, when: ["*"] });
    let backs = 0;
    const g = graphLib.createGraph(
      { nodes: [node("fd"), node("checks"), node("send")], edges: [wire("fd", "checks"), wire("checks", "send"), { ...wire("checks", "fd", "loop"), rounds: 2 }] },
      { fd: async () => ((clock += 4_500), {}), checks: async (_x, io) => ((clock += 2), backs++ === 0 && (await io.back.fd({})), {}), send: async () => ((clock += 1), {}) },
      { log: nodeLog({ write: (e) => runs.push(e) }, { turn: "turn-replay-0001" }), now: () => clock },
    );
    await g.run("fd", {});
    const ran = runs.find((e) => e.name === "checks");
    assert.equal(ran.ms, 4_502, "Answer checks' whole run holds the rewrite it sent back for");
    assert.equal(ran.own, 2, "but its own time is its code alone, never the front door's");
    const delivery = eventEntry({ id: "1794772822042-001207", at: 1794772822042, kind: "step", chat: "texts", turn: "turn-replay-0001", step: { name: "send", of: "delivery", ok: true, ms: 470, input: { parts: 1 }, output: { sent: 1 } } });
    assert.deepEqual([delivery.step, delivery.name, delivery.turn, delivery.ms], ["send", "delivery", "turn-replay-0001", 470], "Text them's delivery is kept under its turn, with its time");

    // 2026-11-17: the Powerback timecards job drafted its report in every one of ten parts, got three notices from the
    // Answer check each time and crashed on the third: the loop wire had no rounds, so the runner took the Front
    // door's 2 and counted the final "let it go" too. With live Tex's wire, three notices fit and a spent budget sends.
    // Three notices, as each part got, then a clean draft: it is sent, not lost.
    const three = await part(["page", "shorter", "one line", "final"], (draft) => (draft === "final" ? null : `fix ${draft}`));
    assert.deepEqual(three.sent, ["final"], "the part's report is sent after three notices");
    assert.equal(three.check.sentBack, 3);
    // A check that never lets go: once the budget is spent the last draft goes anyway, marked spent, never a crash.
    const endless = await part(["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"], () => "again");
    assert.equal(endless.sent.length, 1, "a spent budget still sends a draft");
    assert.equal(endless.check.spent, true, "and says the draft went unchecked");
    // 2026-11-17: a background job's parts were each sent back three times in a row (make it a page, then that's an
    // essay, then one casual line), and the third send-back crashed the part. The checks ran first-wins, one round each,
    // and style blocked a job's answer like a false claim. Now every finding goes back in one notice, and advice alone
    // never holds a job (`checkFindings.js`).
    const job = claimCheck({ question: "check the timecards report", job: { id: "job-replay-0001" } });
    await job.wrapWeb(web).call("search_web", { query: "timecards" });
    assert.equal(await job.check(WALL), null, "a job's part is never held for advice alone");
    const both = claimCheck({ question: "check the timecards report", job: { id: "job-replay-0002" } });
    await both.wrapWeb(web).call("search_web", { query: "timecards" });
    const draft = `${WALL} I've added it to your notes. Can you check the site and forward me the report?`;
    const notice = await both.check(draft);
    assert.match(String(notice), /^Before this goes, check 2 things/, "every finding in one notice");
    assert.ok(!/that's an essay/.test(notice), "never a page and an essay notice together");
    assert.equal(await both.check(draft), null, "and nothing goes back a second time");
  },
};
