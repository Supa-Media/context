// What the bench judge is shown of an answer's emails (`bench/judge.mjs` `emailSeen`).
import { test } from "node:test";
import assert from "node:assert/strict";

// judge-gold 2026-11-26: a sent reply failed "never says it sent ... its tools did not do" because the judge saw only
// note changes, which hold no mail. Sabotage: drop `emails` from the payload and the sent email is not shown.
test("the judge is shown each email an answer sent or drafted, its body cut short, and nothing when there is none", async () => {
  const { buildJudgeRequest } = await import("../judge.mjs");
  const payloadOf = (answer) => JSON.parse(/<answers>\n([\s\S]*)\n<\/answers>/.exec(JSON.parse(buildJudgeRequest({ model: "m", question: { text: "q", must: [], mustNot: [], judge: [], may: [] }, answers: [answer] }).body).messages[0].content)[1]);
  const emails = [
    { to: ["pat@example.invalid"], cc: [], subject: "Re: Monday", replyTo: "t1", body: "x".repeat(900), draft: false },
    { to: ["sam@example.invalid"], cc: [], subject: "Draft", body: "Hi", draft: true },
  ];
  const seen = payloadOf({ id: "a", conversation: [], toolsLine: "", changes: [], emails }).answers[0].emails;
  assert.deepEqual(seen.map((e) => [e.to[0], e.sent]), [["pat@example.invalid", true], ["sam@example.invalid", false]]);
  assert.equal(seen[0].body.length, 601, "a long body is cut to 600 characters and an ellipsis");
  assert.equal("cc" in seen[0], false, "an empty cc is left out");
  assert.equal("emails" in payloadOf({ id: "a", conversation: [], toolsLine: "", changes: [] }).answers[0], false);
  const { body } = buildJudgeRequest({ model: "m", question: { text: "q", must: [], mustNot: [], judge: [], may: [] }, answers: [] });
  assert.match(JSON.parse(body).system, /a sent email was really sent, even though no note changed/);
});
