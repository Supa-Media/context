/**
 * TEX NEVER HANDS THE PERSON WORK IT CAN DO ITSELF (the owner, 2026-10-22).
 *
 * From the owner's chat that day: Tex found Google's Oct 14 Google Voice
 * receipt, lost it by the next text, searched once, and then texted "Forward
 * Google's receipt from your Public Worship Gmail to me, or give me its
 * subject line" and "Check Google Voice's billing history". It had saved a
 * draft saying "I'm passing it on to you" with nothing forwarded, and a
 * question about the receipt was answered with an old Slack test held for a
 * yes. Each line here is one of those, and the honest texts beside them.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-22).
 *
 *  1. `check` never giving `HANDBACK_NOTICE`.
 *     → "an answer that hands the work back gets one more round, once" fails.
 *  2. `offeredKinds` answering every kind. → "an email offer's notice names
 *     only the email" fails.
 *  3. `readEmail` without `passesSomethingOn`. → "an email that says it passes
 *     a receipt on, with nothing forwarded, is refused" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { HANDBACK_NOTICE, claimCheck, handsWorkBack, offerNotice, offeredKinds } from "../src/agent/claimCheck.js";
import { runTurn } from "../src/agent/turn.js";
import { PASSES_ON_ERROR, passesSomethingOn, readEmail } from "../src/tools/email.js";

test("the texts that handed the receipt back are read as handing work back", () => {
  for (const said of [
    "Forward Google's receipt from your Public Worship Gmail to me, or give me its subject line, and I'll attach it to a new draft to Kansi.",
    "I can't make the forward yet because I can't find Google's Oct 14 receipt in the Public Worship inbox. Forward it to me from Google Payments, or give me its subject line, and I'll make the draft.",
    "Forward me Google's Oct 14 receipt and I'll put it on the draft to Kansi.",
    "Check Google Voice's billing history for the October 14 payment, or forward me the receipt if you find it.",
    "You'll need to log in to Google Voice and download it.",
    "Could you send me the receipt?",
  ]) {
    assert.ok(handsWorkBack(said), said);
  }
});

test("a step only they can take, an offer, a report, or their own to-do is not handing back", () => {
  for (const said of [
    "Google wants the sign-in code it just sent you. Tap this, type it in, and text me when it's done:\nhttps://context.lc/b/7Kq2",
    "Want me to forward her that receipt?",
    "Forwarded it to Kansi.",
    "Found it. Google sent it on Oct 14.",
    "Check-in is at 3 pm.",
    "Give it a 👍 and I'll send it.",
    "Your notes don't have his number.",
    "I'll attach it to the draft to Kansi.",
    "Kansi asked you to send her the receipt.",
  ]) {
    assert.ok(!handsWorkBack(said), said);
  }
});

test("an answer that hands the work back gets one more round, once, and an offer can still be checked after it", () => {
  const claims = claimCheck({ question: "YESSSSSSSS" });
  const first = "No receipt in it. Forward it to me from Google Payments and I'll make the draft. Want me to forward it to Kansi then?";
  assert.equal(claims.check(first), HANDBACK_NOTICE);
  assert.ok(HANDBACK_NOTICE.includes("search_email") && HANDBACK_NOTICE.includes("from:"), "the notice names the other ways to search");
  // The same words again are not sent back a second time: the check never loops.
  const again = claims.check(first);
  assert.ok(again === null || !again.includes("find, forward, check"), "handing back is noticed once a turn");
});

test("an email offer's notice names only the email, never a Slack message from earlier", () => {
  const offer = "Want me to forward her that receipt?";
  const notice = claimCheck({ question: "interesting, so why didn't she get the receipt for the last payment" }).check(offer);
  assert.equal(notice, offerNotice(offeredKinds(offer)));
  assert.ok(notice.includes("send_email") && !notice.includes("slack_api") && !notice.includes("calendar_event"), notice);
  assert.ok(notice.includes("never hold something from an earlier text"), notice);
});

test("an email that says it passes a receipt on, with nothing forwarded, is refused for a draft and a send alike", () => {
  const draft = {
    to: ["kansi@example.com"],
    subject: "Google Voice receipt for October 14 ($25.26)",
    body: "Hi Kansi,\n\nThe Google Voice payment on October 14 was $25.26. Google sent that receipt only to my inbox, so I’m passing it on to you.\n\nThanks,\nSeyi",
  };
  assert.equal(readEmail(draft).error, PASSES_ON_ERROR);
  assert.ok(PASSES_ON_ERROR.includes("forward") && PASSES_ON_ERROR.includes("search_email"));
  // The same words with Google's email forwarded below them go.
  assert.ok(readEmail({ ...draft, forward: "email:me@example.com/18c0ffee" }).email?.forward === "18c0ffee");
  for (const words of ["Receipt attached.", "Please find attached the invoice.", "Here's the receipt from Google.", "I've attached the PDF."]) {
    assert.ok(passesSomethingOn("Receipt", words), words);
  }
  assert.ok(passesSomethingOn("Fwd: Your Google Voice receipt", "Hi Kansi"));
  for (const words of ["Can you send me the attachment?", "Did you get the receipt?", "Thanks for the invoice.", "I'm including Sam on this."]) {
    assert.ok(!passesSomethingOn("Hello", words), words);
  }
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

const SEARCH = {
  name: "search_email",
  description: "Search their email",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};

test("handed back, Tex searches again itself and answers with what it found", async () => {
  const MAIN = "@cf/acme/main-model";
  const ai = scripted([
    { text: "I can't find it. Forward me Google's receipt and I'll attach it." },
    { calls: [{ name: "search_email", args: { query: "from:payments-noreply@google.com 25.26" } }] },
    { text: "Found Google's Oct 14 receipt, sent to you on Oct 14." },
  ]);
  const claims = claimCheck({ question: "YESSSSSSSS" });
  const result = await runTurn({
    question: "YESSSSSSSS",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: claims.check,
    callTool: claims.wrap(async () => ({ content: [{ type: "text", text: "- email:me@example.com/18c0ffee\n    Oct 14 · from Google Payments · Your Google Voice receipt" }] })),
  });
  assert.equal(ai.calls.length, 3);
  assert.ok(JSON.stringify(ai.calls[1]).includes("that is yours to do"), "the second round is told to do it itself");
  assert.match(result.answer, /Found Google's Oct 14 receipt/);
});

test("every texted turn is told never to hand them work, whatever its production setup says", async () => {
  const { DO_IT_YOURSELF_LINE, systemPrompt } = await import("../src/agent/prompt.js");
  for (const notes of [null, { prompt: "You are Tex, from the production note." }]) {
    const prompt = systemPrompt(null, { texting: true, notes });
    assert.ok(prompt.includes(DO_IT_YOURSELF_LINE), "the rule is in the prompt");
    assert.ok(prompt.includes("Never take back what an earlier answer said"), "and so is the rule against taking back what it read");
  }
});
