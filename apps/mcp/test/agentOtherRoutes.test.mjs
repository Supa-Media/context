/**
 * WHEN ONE SOURCE FAILS, TEX TRIES THE OTHERS (the owner, 2026-10-23).
 *
 * The owner asked "but planning center works now? am I serving sunday?"
 * while Planning Center reads were failing. Tex said it couldn't tell them,
 * promised to text later with nothing set up to, and told them to check the
 * Planning Center app themselves. The serving email was in their Gmail.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-23).
 *
 *  1. `check` without the other-routes notice → "the Planning Center answer
 *     is sent back to try email, calendar, notes and the browser" fails.
 *  2. `untriedRoutes` answering every route → "a turn that already took a
 *     road is told only the others" fails.
 *  3. `promisesLater` always false → "a promise to text later with nothing
 *     to keep it gets one more round" fails.
 *  4. `handsWorkBack` without `LOOK_YOURSELF` → "check it yourself in the
 *     app is handing back" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { HANDBACK_NOTICE, claimCheck, handsWorkBack } from "../src/agent/claimCheck.js";
import { mayAsk } from "../src/agent/handbackJudge.js";
import { LATER_NOTICE, givesUp, promisesLater, untriedRoutes } from "../src/agent/otherRoutes.js";
import { OTHER_ROUTES_LINE, systemPrompt } from "../src/agent/prompt.js";
import { runTurn } from "../src/agent/turn.js";

const QUESTION = "but planning center works now? am I serving sunday?";
const GAVE_UP =
  "Planning Center still isn’t answering, so I can't tell you whether you're serving Sunday yet. It's the app connection failing, not a web page, and I've tried it three times, the last two just now. " +
  "Once it answers, I'll check your serving schedule and text you what I find. You can also check it yourself in the Planning Center app or at https://planningcenteronline.com";

test("the Planning Center answer is sent back to try email, calendar, notes and the browser", async () => {
  const claims = claimCheck({ question: QUESTION });
  const read = claims.wrap(async () => ({ isError: true, content: [{ type: "text", text: "Planning Center's server failed." }] }));
  await read("app_read", { app: "planning-center", tool: "services_plans" });
  const notice = claims.check(GAVE_UP);
  for (const road of ["search_email", "from:planningcenteronline.com", "calendar", "notes", "browse"]) assert.ok(notice.includes(road), road);
  assert.ok(notice.includes("where you read it") && notice.includes("Never tell them to check it themselves"));
  // The next round is still checked for handing back and for the promise.
  assert.equal(claims.check(GAVE_UP), HANDBACK_NOTICE);
  assert.equal(claims.check(GAVE_UP), LATER_NOTICE);
});

test("a turn that already took a road is told only the others, and one that took them all is let through", () => {
  assert.deepEqual(untriedRoutes([{ name: "app_read", ok: false }, { name: "search_email", ok: true }]), ["calendar", "notes", "browser"]);
  assert.deepEqual(untriedRoutes(["search_email", "read_calendar", "search", "browse"].map((name) => ({ name, ok: true }))), []);
});

test("an answer that says it can't, with nothing failing, is not this check's", () => {
  const claims = claimCheck({ question: "what's his number?" });
  const notice = claims.check("Your notes don't have his number, and I can't find it in your email either.");
  assert.ok(notice === null || !notice.includes("one source failed"), notice);
});

test("the answers that give up are read as giving up, and the ones that answer are not", () => {
  for (const said of [GAVE_UP, "I couldn't check Planning Center just now.", "I have no way to tell yet."]) assert.ok(givesUp(said), said);
  for (const said of ["You're serving Sunday as Stage Manager 2, call at 7:30am.", "Found it in Planning Center's email of Oct 20."]) assert.ok(!givesUp(said), said);
});

test("a promise to text later with nothing to keep it gets one more round; a routine or a job keeps it", async () => {
  assert.ok(promisesLater(GAVE_UP));
  for (const said of ["Give it a 👍 and I'll send it.", "I'll text you once you say yes.", "You're serving Sunday."]) assert.ok(!promisesLater(said), said);
  assert.equal(claimCheck({ question: QUESTION }).check("Once it answers, I'll text you what I find."), LATER_NOTICE);

  const routine = claimCheck({ question: QUESTION });
  await routine.wrap(async () => ({ content: [{ type: "text", text: "saved" }] }))("write_note", { path: "tex/routines/hourly/serving-sunday.md", content: "---\nuntil: they know whether they serve Sunday\n---\n" });
  assert.equal(routine.check("Once it answers, I'll text you what I find."), null);

  const job = claimCheck({ question: QUESTION });
  await job.wrap(async () => ({ content: [{ type: "text", text: "started" }] }))("start_background_job", { task: "find it" });
  assert.equal(job.check("I'll text you when it's done."), null);
});

test("check it yourself in the app is handing back, and the judge reads it", () => {
  for (const said of [
    "You can also check it yourself in the Planning Center app or at https://planningcenteronline.com",
    "You can always see your schedule in the Planning Center app.",
    "You could also look it up yourself.",
  ]) {
    assert.ok(handsWorkBack(said), said);
    assert.ok(mayAsk(said), said);
  }
  assert.ok(!handsWorkBack("You said you'd check it yourself, so I left it."));
});

test("every texted turn is told to try the other roads when a source fails", () => {
  for (const notes of [null, { prompt: "You are Tex, from the production note." }]) {
    const prompt = systemPrompt(null, { texting: true, notes });
    assert.ok(prompt.includes(OTHER_ROUTES_LINE));
  }
  assert.ok(!OTHER_ROUTES_LINE.includes("couldn't check their notes just now"));
});

/** A Workers AI binding that answers from a script, one reply per call. */
function scripted(replies) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push(input.messages);
      const reply = replies.shift();
      if (!reply) throw new Error("script ran out");
      const tool_calls = (reply.calls ?? []).map((call, i) => ({
        id: `call_${calls.length}_${i}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
      return { choices: [{ message: { content: reply.text ?? "", tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

const tool = (name) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });

test("sent back, Tex finds the serving email and answers with where it read it", async () => {
  const MAIN = "@cf/acme/main-model";
  const ai = scripted([
    { calls: [{ name: "app_read", args: { app: "planning-center" } }] },
    { text: "Planning Center still isn't answering, so I can't tell you whether you're serving Sunday." },
    { calls: [{ name: "search_email", args: { query: "from:planningcenteronline.com sunday" } }] },
    { text: "Yes: Stage Manager 2 in Brooklyn this Sunday, Oct 25, 7:30am call, 10am service (from Planning Center's email)." },
  ]);
  const claims = claimCheck({ question: QUESTION });
  const result = await runTurn({
    question: QUESTION,
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [tool("app_read"), tool("search_email")],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: claims.check,
    callTool: claims.wrap(async (name) =>
      name === "app_read"
        ? { isError: true, content: [{ type: "text", text: "Planning Center's server failed." }] }
        : { content: [{ type: "text", text: "- email:me@example.com/18c0ffee\n    Oct 20 · from Planning Center · Can you serve? Stage Manager 2, Brooklyn, Sun Oct 25" }] },
    ),
  });
  assert.ok(JSON.stringify(ai.calls[2]).includes("one source failed"), "the third round is told to try the other roads");
  assert.match(result.answer, /Stage Manager 2/);
});
