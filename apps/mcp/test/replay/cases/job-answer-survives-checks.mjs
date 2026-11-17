import assert from "node:assert/strict";
import graphLib from "../../../../../packages/shared/src/texGraph.cjs";
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

export default {
  id: "job-answer-survives-checks",
  incident:
    "2026-11-17: Seyi asked Tex to look into the Powerback timecards. The job's first part had the answer in three minutes, but every one of its ten parts drafted a report, got three notices from the Answer check (make it a page, cut it to a line, the email isn't held) and crashed, so the job ended with nothing sent.",
  cause:
    "Since the simpler graph the Answer check's loop wire had no rounds of its own, so the runner took the Front door's 2, counted the final 'let it go' as a send-back too, and threw on the third notice instead of sending the draft.",
  path: "background job part",
  async run() {
    // Three notices, as each part got, then a clean draft: it is sent, not lost.
    const three = await part(["page", "shorter", "one line", "final"], (draft) => (draft === "final" ? null : `fix ${draft}`));
    assert.deepEqual(three.sent, ["final"], "the part's report is sent after three notices");
    assert.equal(three.check.sentBack, 3);
    // A check that never lets go: once the budget is spent the last draft goes anyway, marked spent, never a crash.
    const endless = await part(["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"], () => "again");
    assert.equal(endless.sent.length, 1, "a spent budget still sends a draft");
    assert.equal(endless.check.spent, true, "and says the draft went unchecked");
  },
};
