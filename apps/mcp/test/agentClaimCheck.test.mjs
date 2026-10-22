/**
 * A TEXTED ANSWER IS CHECKED AGAINST WHAT THE TURN DID (`claimCheck.js`),
 * from the owner's chat with Tex on 2026-10-21.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-21).
 *
 *  1. `turn.js` returning the first answer without calling `answerCheck`.
 *     → "an answer that says it added something, with no write, gets one more round" fails.
 *  2. `claimCheck` counting a failed or held call as a write.
 *     → "a write that was refused is no write" fails.
 *  3. `check` giving its notice every time it is asked.
 *     → "the notice is given once, so the check never loops" fails.
 *  5. `offersAHeldChange` without its preview and yes-ask checks.
 *  6. `offersAHeldChange` without `SLACK_OFFER`. → `a Slack message offered
 *     in Tex's own words is an offer too`.
 *     → emailGate's "a preview of a forward in Tex's own words is held as it
 *     is shown…" and "a preview of an email…" fail.
 *  4. `check` never giving `OFFER_NOTICE`.
 *     → "an offer with nothing held is sent back; once the call is held, it goes" fails.
 *  7. `wrapWeb` not marking a call as tried (2026-10-22).
 *     → "\"I couldn't open it\" with the web untried gets one more round…" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { CLAIM_NOTICE, MUTE_NOTICE, TRY_NOTICE, asksToMute, claimCheck, claimsAChange, offerNotice, offeredKinds, offersAHeldChange, saysItCouldNot } from "../src/agent/claimCheck.js";
import { runTurn } from "../src/agent/turn.js";

const MAIN = "@cf/acme/main-model";
const WRITE = {
  name: "write_note",
  description: "Write a note",
  inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
  annotations: { readOnlyHint: false },
};

test("the words from the chat that said a change was made are read as a claim, and the honest ones are not", () => {
  assert.ok(claimsAChange("You're right, I dropped that one. It's on your to-do list now, at the top under this week: check the router deploy."));
  assert.ok(claimsAChange("I've added it to your calendar for Friday."));
  assert.ok(claimsAChange("Saved it to your notes."));
  assert.ok(claimsAChange("Put it on your list."));
  assert.ok(!claimsAChange("I wrote up the bug. It's about me not being able to forward the receipt with its PDF attached."));
  assert.ok(!claimsAChange("I can't attach the PDF from here, so forward it yourself."));
  assert.ok(!claimsAChange("Want me to add a to-do to check the router deploy?"));
});

test("a text asking never to be texted about something is a mute", () => {
  assert.ok(asksToMute("never message me about github stuff unless i ask"));
  assert.ok(asksToMute("Stop texting me about deploys"));
  assert.ok(asksToMute("no more pings about CI please"));
  assert.ok(!asksToMute("what's on my list today?"));
  assert.ok(!asksToMute("tell me about the github outage"));
});

test("a write that went through clears a claim; a write that was refused is no write", async () => {
  const done = claimCheck({ question: "add it to my to-do list" });
  await done.wrap(async () => ({ content: [{ type: "text", text: "Saved." }] }))("write_note", { path: "todo.md", content: "x" });
  assert.equal(done.check("It's on your to-do list now."), null);

  const refused = claimCheck({ question: "add it to my to-do list" });
  await refused.wrap(async () => ({ isError: true, content: [{ type: "text", text: "Not saved." }] }))("write_note", { path: "todo.md", content: "x" });
  assert.equal(refused.check("It's on your to-do list now."), CLAIM_NOTICE);

  const read = claimCheck({ question: "add it to my to-do list" });
  await read.wrap(async () => ({ content: [{ type: "text", text: "..." }] }))("read_note", { path: "todo.md" });
  assert.equal(read.check("It's on your to-do list now."), CLAIM_NOTICE, "a read is not a write");
});

test("\"Will do.\" to a mute, with nothing kept, is sent back; kept in tex/attention.md, it goes", async () => {
  const question = "never message me about github stuff unless i ask";
  const forgot = claimCheck({ question });
  assert.equal(forgot.check("Will do."), MUTE_NOTICE);

  const elsewhere = claimCheck({ question });
  await elsewhere.wrap(async () => ({ content: [] }))("write_note", { path: "todo.md", content: "x" });
  assert.equal(elsewhere.check("Will do."), MUTE_NOTICE, "a write somewhere else keeps nothing");

  const kept = claimCheck({ question });
  await kept.wrap(async () => ({ content: [] }))("write_note", { path: "tex/attention.md", content: "---\nmute: [github]\n---\n" });
  assert.equal(kept.check("Muted github."), null);
});

test("the notice is given once, so the check never loops", () => {
  const once = claimCheck({ question: "hi" });
  assert.equal(once.check("I've added it."), CLAIM_NOTICE);
  assert.equal(once.check("I've added it."), null);
});

test("an offer of a calendar change or an email, in words, is read as one; an offer of anything else is not", () => {
  assert.ok(offersAHeldChange("Want me to add 'Emmanuela/Sayo,' 7 to 8 pm today?"));
  assert.ok(offersAHeldChange("Do you want me to put it on your calendar?"));
  assert.ok(offersAHeldChange("Should I move the dentist to Friday?"));
  assert.ok(offersAHeldChange("Want me to forward it to Relay?"));
  assert.ok(offersAHeldChange("Want me to reply to Sam saying yes?"));
  assert.ok(!offersAHeldChange("Want me to add a to-do to check the router deploy?"));
  assert.ok(!offersAHeldChange("Want me to add a to-do for Friday?"));
  assert.ok(!offersAHeldChange("Want me to send you the list?"));
  assert.ok(!offersAHeldChange("Want me to look into it?"));
  // 2026-10-22: two prose asks with nothing held, and a 👍 on each reached nothing.
  assert.ok(offersAHeldChange("Not yet. Say the word and I'll send it to Jo Park on Acme Slack."));
  assert.ok(offersAHeldChange("Here's the message as it would go:\n\n“Hey Jo, testing.”\n\nSay yes and I'll try sending it again."));
  assert.ok(!offersAHeldChange("Say the word and I'll look it up."));
  assert.ok(!offersAHeldChange("I'll add it once you say yes below."));
});

test("a preview in Tex's own words, or its own ask for a yes or 👍, is an offer too (2026-10-21 2:25 PM)", () => {
  assert.ok(offersAHeldChange("Here's the email:\n\nTo: supa.media.llc@receipts.example\nForward of: Your receipt from Anthropic\n\nSay yes and I'll send it."));
  assert.ok(offersAHeldChange("Say yes and I'll file it."));
  assert.ok(offersAHeldChange("Give this a \u{1F44D} and I'll send it."));
  assert.ok(offersAHeldChange("Want me to file a bug?"));
  assert.ok(!offersAHeldChange("Reply yes if you want the list."));
  assert.ok(!offersAHeldChange("To be fair, that's fine."));
});

test("a Slack message offered in Tex's own words is an offer too (2026-10-22)", () => {
  assert.ok(offersAHeldChange("I found him this time. I'd DM Jo Park on Acme Slack: \"Hey Jo, just testing.\""));
  assert.ok(offersAHeldChange("Want me to post that in #general on Slack?"));
  assert.ok(offersAHeldChange("Shall I message Jo on Slack?"));
  assert.ok(!offersAHeldChange("Jo posted in #general on Slack this morning."));
  assert.ok(!offersAHeldChange("I'd check Slack first."));
});

test("an offer with nothing held is sent back; once the call is held, it goes", async () => {
  const offer = "Want me to add 'Emmanuela/Sayo,' 7 to 8 pm today?";
  const notice = claimCheck({ question: "dinner at 7" }).check(offer);
  assert.equal(notice, offerNotice(offeredKinds(offer)));
  assert.ok(notice.includes("calendar_event") && !notice.includes("slack_api"), "the notice names only the calendar it offered");
  const held = claimCheck({ question: "dinner at 7" });
  await held.wrap(async () => ({ isError: true, held: true, content: [] }))("calendar_event", {});
  assert.equal(held.check("I'll add Emmanuela and Sayo at 7."), null);
});

/*
  2026-10-22: "I couldn't open the LSB text for 28 or 29 from here", then,
  asked why, "I was wrong. I hadn't tried before I said it."
*/
test("an answer that says it couldn't open or read something is read as one; one that couldn't find a note is not", () => {
  assert.equal(saysItCouldNot("I couldn't open the LSB text for 28 or 29 from here, so the Overview is blank."), true);
  assert.equal(saysItCouldNot("I can\u2019t access that page."), true);
  assert.equal(saysItCouldNot("I wasn't able to pull up the chapter."), true);
  assert.equal(saysItCouldNot("Your notes don't have his number."), false);
  assert.equal(saysItCouldNot("I couldn't find that in your notes."), false);
});

test("\"I couldn't open it\" with the web untried gets one more round; after a try, or with no web, it goes", async () => {
  const said = "I couldn't open the LSB text for 28 or 29 from here.";
  const web = { tools: [], usage: {}, call: async () => ({ content: [{ type: "text", text: "That page could not be opened." }], isError: true }) };

  const untried = claimCheck({ question: "write the overview" });
  untried.wrapWeb(web);
  assert.equal(untried.check(said), TRY_NOTICE);

  const tried = claimCheck({ question: "write the overview" });
  await tried.wrapWeb(web).call("open_page", { urls: ["https://example.org/deut-28"] });
  assert.equal(tried.check(said), null, "a try that failed is an honest can't");

  const offline = claimCheck({ question: "write the overview" });
  assert.equal(offline.wrapWeb(null), null);
  assert.equal(offline.check(said), null, "a turn with no web has nothing to try");
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

function turn(ai, claims, callTool) {
  return runTurn({
    question: "do it for me, and if you can't do it, file a bug",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [WRITE],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: claims.check,
    callTool: claims.wrap(callTool),
  });
}

test("an answer that says it added something, with no write, gets one more round", async () => {
  const ai = scripted([{ text: "It's on your to-do list now, at the top under this week." }, { text: "I haven't added it yet. Want me to?" }]);
  const claims = claimCheck({ question: "do it for me" });
  const result = await turn(ai, claims, async () => ({ content: [] }));
  assert.equal(result.answer, "I haven't added it yet. Want me to?");
  assert.equal(ai.calls.length, 2);
  assert.ok(JSON.stringify(ai.calls[1]).includes("no change to their notes went through"), "the second round is told why");
});

test("an answer backed by a write that went through goes as it is, in one round", async () => {
  const ai = scripted([
    { calls: [{ name: "write_note", args: { path: "todo.md", content: "- check the router" } }] },
    { text: "It's on your to-do list now." },
  ]);
  const claims = claimCheck({ question: "add it" });
  const result = await turn(ai, claims, async () => ({ content: [{ type: "text", text: "Saved todo.md." }] }));
  assert.equal(result.answer, "It's on your to-do list now.");
  assert.equal(ai.calls.length, 2);
});
