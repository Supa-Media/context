/**
 * THE FRONT DOOR'S FIGURE CHECK, OVER WHAT THE MODEL SAW (Dev2, 2026-11-15;
 * `src/agent/sourcedFigures.js` `seenFiguresNotice`, run by `untriedWeb.js`).
 * The reply reviewer no longer reads chat turns; "unsourced" was most of what
 * it sent back, and both of its false alarms read in full were that too: a
 * read it saw cut to 16K characters, and search results judged by the words
 * searched for. This check reads every message whole, and the prompt.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `seenFiguresNotice` returning null: "a figure in nothing the model saw is
 *    sent back" and the front-door test fail;
 *  - tool messages left out of the sources: "a figure past 16K characters of a
 *    read is sourced" fails;
 *  - the action guard dropped: "a turn with no action is not checked" fails;
 *  - `system` left out: "a figure in the prompt is sourced" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ask, createEgressWorld, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { RECHECK_FROM } from "../../../packages/tex/gateway/agent/recheck.js";
import { seenFiguresNotice } from "../../../packages/tex/gateway/agent/sourcedFigures.js";
import { untriedWebCheck } from "../../../packages/tex/gateway/agent/untriedWeb.js";
import { readTexConfig } from "../../../scripts/lib/texConfigFile.mjs";

const read = (text) => [
  { role: "user", text: "how fast are replies lately?" },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "fetch", args: { path: "tex/history.ledger.json" } }] },
  { role: "tool", id: "c1", name: "fetch", text },
];

test("a figure in nothing the model saw is sent back, naming it", () => {
  const notice = seenFiguresNotice("Replies take 23% longer than last week.", { messages: read("median 4.1 s, p90 9.0 s") });
  assert.match(String(notice), /23%/);
});

test("a figure past 16K characters of a read is sourced: the check reads it whole", () => {
  const long = `${"x".repeat(50_000)} median reply 23 s`;
  assert.equal(seenFiguresNotice("Your median reply took 23% of the minute, about 23 s.", { messages: read(`${long} and 23%`) }), null);
});

test("a figure in the prompt, their texts or an earlier text is sourced", () => {
  assert.equal(seenFiguresNotice("Your budget is still $400 a month.", { messages: read("no figures"), system: "About them: budget $400 a month" }), null);
  assert.equal(seenFiguresNotice("That's the $40 you mentioned.", { messages: [{ role: "user", text: "it was $40" }, ...read("nothing")] }), null);
});

test("a turn with no action, or with a picture, is not checked", () => {
  assert.equal(seenFiguresNotice("A tip of 18% is usual.", { messages: [{ role: "user", text: "what's a normal tip?" }] }), null);
  const pictured = [{ role: "user", text: "what's on the receipt?", attachments: [{ kind: "image" }] }, ...read("")];
  assert.equal(seenFiguresNotice("The total was $83.20.", { messages: pictured }), null);
});

test("a check's note quoting the draft is no source for its figures", () => {
  const messages = [...read("nothing"), { role: "user", text: `${RECHECK_FROM}\nYour draft: Ratings are 94% and 88%.` }];
  assert.match(String(seenFiguresNotice("Ratings are 94% and 88%.", { messages })), /94%/);
});

test("the front door's check runs it once a turn, after the can't-open check", () => {
  const check = untriedWebCheck();
  const context = { messages: read("median 4.1 s") };
  assert.match(String(check.check("It got 40% faster.", context)), /40%/);
  assert.equal(check.check("It got 40% faster.", context), null, "once a turn");
});

test("on the front door, a quoted figure no read backs gets one more round", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([
      { toolCalls: [{ name: "open_page", args: { url: "https://example.com/pricing" } }] },
      { text: "Their Pro plan is $49 a month." },
      { text: "Their Pro plan is $29 a month (https://example.com/pricing)." },
    ]);
    const asked = await ask(world.env, TOKEN_TEXTS, "what does example's pro plan cost?");
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(world.model.requests.length, 3);
    assert.match(JSON.stringify(world.model.requests[2]), /quotes figures that nothing you read in this turn backs/);
  } finally {
    world.restore();
  }
});

test("the Reply reviewer reads only a job's report and a routine's text (Dev2, 2026-11-15; in the Answer check 2026-11-16)", async () => {
  // The reviewer is folded into the Answer check: every Front door draft goes through it, the wire back to the Front door
  // carries its notice, and its model review runs only on a turn `runTheModel.js` tags `reviewedAs` (a report or a routine).
  // Sabotage: the `t.reviewedAs` guard dropped from answerCheck.js, or the reviewer's old wire turned back on, and this fails.
  const config = readTexConfig();
  const wired = (from, to) => config.edges.filter((w) => w.from === from && w.to === to);
  assert.deepEqual(wired("fd", "answerCheck").map((w) => w.mode), ["wait"], "every draft is checked before it goes");
  assert.deepEqual(wired("answerCheck", "fd").map((w) => w.mode), ["loop"], "a draft sent back goes to the Front door");
  assert.ok(config.nodes.find((n) => n.id === "answerCheck").on, "the Answer check is on");
  // Dev2, 2026-11-23 (the no-shadow steps): the reviewer is its own step again, reached only over the Answer check's uses wire.
  assert.deepEqual(config.edges.filter((w) => w.from === "reviewer" || w.to === "reviewer").map((w) => [w.from, w.to, w.mode]), [["answerCheck", "reviewer", "uses"]], "the Reply reviewer runs only inside the Answer check");
  const { answerCheckNode } = await import("../../../packages/tex/gateway/agent/graph/nodes/answerCheck.js");
  const run = async (reviewedAs) => {
    let reviewed = 0;
    const turn = {
      reviewedAs,
      drafts: { waiting: { draft: "Done: I saved it.", info: {} } },
      answerChecks: { code: async () => ({ notice: null, review: true }), review: async () => ((reviewed += 1), null) },
    };
    const back = { fd: async () => ({ pending: false }) }; // the Front door sends the draft it was handed back
    const out = await answerCheckNode({ pending: true }, { ctx: { turn }, back });
    return { reviewed, out };
  };
  for (const kind of ["report", "routine"]) assert.equal((await run(kind)).reviewed, 1, `a ${kind} is reviewed`);
  const chat = await run(null);
  assert.equal(chat.reviewed, 0, "a chat turn's draft is never read by the reviewer");
  assert.equal(chat.out.reviews, 0);
});
