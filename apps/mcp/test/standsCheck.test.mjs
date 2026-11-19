/**
 * AN ANSWER THAT SAYS IT IS STILL THERE NEEDS A LOOK IN THIS TURN, OF THE SAME KIND (2026-11-19;
 * `src/agent/standsCheck.js`). A console 1:1 was asked to save a Gmail reply
 * as a draft and not send it; Tex ran no tool and said "I already did this at
 * 1:31 PM … The reply is saved as a Gmail draft", and the draft was gone.
 * A second miss: an inbox read to summarize an email backed "I already saved
 * the draft". So a claim, a skip or a wait is backed only by an act or a
 * fresh look of its own kind (draft, email, chat, calendar, note), and the
 * gate runs on every chat turn (`runTheModel.js` `withStands`), fail-closed
 * on the turn's last answer (`standsGate` `final`).
 *
 * Sabotage (temporary local edits to `src/agent/standsCheck.js`, reverted):
 *  - (a) `backedThisTurn` treats `wanted` as empty always, so kinds are
 *    ignored: "kind matching: an inbox read never backs a draft claim", "a
 *    held send_email does not back a draft claim", "a notes write does not
 *    back an email claim" and the chat/email cases fail;
 *  - (b) `standsGate`'s `final` always returns null: "final returns
 *    STANDS_HONEST for a second unbacked claim", "for a last-round claim" and
 *    "withStands sends the notice" (its unbacked case) fail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TRY_NOTICE } from "../src/agent/claimCheck.js";
import { frontDoorChecks, untriedWebCheck } from "../src/agent/untriedWeb.js";
import { withStands } from "../src/agent/texEntryPoint/runTheModel.js";
import {
  STANDS_HONEST,
  STANDS_NOTICE,
  backedThisTurn,
  checkedThisTurn,
  claimsItStands,
  standsCheck,
  standsGate,
  standsNotice,
  stepOf,
} from "../src/agent/standsCheck.js";

const INCIDENT = "I already did this at 1:31 PM. The reply is saved as a Gmail draft in your account. Nothing was sent.";
const DRAFT_EARLIER = "I already saved the draft reply to Bo earlier, so I didn't make a second one.";
const console1to1 = { claims: null, runner: false, texted: false, group: null, job: null, front: true, client: "context_console" };

test("an answer that says a thing is already done or still in place is a claim", () => {
  assert.equal(claimsItStands("I already did this at 1:31 PM."), true);
  assert.equal(claimsItStands(INCIDENT), true);
  assert.equal(claimsItStands("Done — it's already in your drafts."), true);
  assert.equal(claimsItStands("Nothing was sent."), true);
  assert.equal(claimsItStands("I saved it to your drafts."), true);
});

test("an answer that asks, previews, refuses or states a plain fact is not a claim", () => {
  assert.equal(claimsItStands("Want me to check whether the draft is still there?"), false);
  assert.equal(claimsItStands("Here's the reply: Hi Bo, thanks for the update. Reply 👍 and I'll save it as a draft."), false);
  assert.equal(claimsItStands("I couldn't save the draft: Gmail refused it."), false);
  assert.equal(claimsItStands("The meeting is at 3pm."), false);
});

test("a claim with no call in the turn gets the notice, and a turn that checked its kind does not", () => {
  assert.equal(standsNotice(INCIDENT, []), STANDS_NOTICE);
  assert.equal(standsNotice(INCIDENT, [{ name: "search", ok: true, args: { query: "notes" } }]), STANDS_NOTICE, "a notes search is not a fresh check");
  assert.equal(standsNotice(INCIDENT, [{ name: "save_email_draft", ok: false }]), STANDS_NOTICE, "a write that failed is not done");
  assert.equal(standsNotice(INCIDENT, [{ name: "save_email_draft", ok: true }]), null);
  assert.equal(standsNotice(INCIDENT, [{ name: "send", ok: true, action: "email_draft" }]), null);
  assert.equal(standsNotice(INCIDENT, [{ name: "send", ok: true, action: "email_draft", held: true }]), null, "a held email draft is checked");
  assert.equal(standsNotice(INCIDENT, [{ name: "send_email", ok: false, held: true }]), STANDS_NOTICE, "a held send of an email does not back a draft claim");
  assert.equal(standsNotice(INCIDENT, [{ name: "search_email", ok: true }]), STANDS_NOTICE, "a mail search with no args is no look at drafts");
  assert.equal(standsNotice(INCIDENT, [{ name: "search", ok: true, args: { query: "in:drafts lumber" } }]), null);
  assert.equal(standsNotice("The meeting is at 3pm.", []), null, "no claim, no notice");
  assert.equal(checkedThisTurn([{ name: "fetch", ok: true, args: { url: "https://example.com/" } }]), false);
});

test("kind matching: an inbox read never backs a draft claim", () => {
  const inboxRead = stepOf("search_email", { query: "subject:Quarterly plan" }, {});
  const read = stepOf("read_email", { id: "email:me@example.com/1" }, {});
  assert.equal(backedThisTurn([inboxRead, read], ["draft"]), false, "a search or read of the inbox is not a look at drafts");
  assert.equal(backedThisTurn([inboxRead, read], []), false, "with no kind named, a read is still no act");
  assert.equal(backedThisTurn([stepOf("save_email_draft", { to: "bo@example.com" }, {})], []), true, "with no kind named, a write counts");
  assert.equal(standsNotice(DRAFT_EARLIER, [inboxRead, read]), STANDS_NOTICE);
  // Other kinds' acts do not back a draft claim either.
  assert.equal(standsNotice(DRAFT_EARLIER, [stepOf("send_email", { to: "bo@example.com" }, { held: true })]), STANDS_NOTICE);
  assert.equal(standsNotice(DRAFT_EARLIER, [stepOf("write", { path: "x.md" }, {})]), STANDS_NOTICE);
});

test("standsCheck fires once a turn, and a look in the turn makes the claim stand", async () => {
  const plain = standsCheck();
  assert.equal(plain.check(INCIDENT), STANDS_NOTICE);
  assert.equal(plain.check(INCIDENT), null, "once a turn");

  const looked = standsCheck();
  const calls = [];
  const wrapped = looked.wrap(async (name, args) => {
    calls.push(name);
    return { content: [{ type: "text", text: "ok" }] };
  });
  await wrapped("save_email_draft", { to: "bo@example.com" });
  assert.equal(looked.check(INCIDENT), null, "a draft save this turn is a basis for the claim");
  assert.deepEqual(calls, ["save_email_draft"]);
});

test("(a) the incident: a summary of an email with a draft claim gets the notice, in both tool names", () => {
  const question = "Summarize the Quarterly plan email and save a reply to Bo as a Gmail draft.";
  const v1 = [stepOf("search_email", { query: "subject:Quarterly plan" }, {}), stepOf("read_email", { id: "email:me@example.com/1" }, {})];
  assert.equal(standsNotice(DRAFT_EARLIER, v1, question), STANDS_NOTICE);
  const v2 = [stepOf("search", { email: true, query: "subject:Quarterly plan" }, {}), stepOf("fetch", { id: "email:me@example.com/1" }, {})];
  assert.equal(standsNotice(DRAFT_EARLIER, v2, question), STANDS_NOTICE);
});

test("(b) a DM claim with no chat call gets the notice; a held Google Chat send or a chat look backs it", () => {
  const dm = "You're already in that DM with Bo twice, so I won't send it again.";
  assert.equal(standsNotice(dm, []), STANDS_NOTICE);
  assert.equal(standsNotice(dm, [stepOf("send", { action: "google_chat", to: "bo@example.com", text: "hi" }, { held: true })]), null);
  assert.equal(standsNotice(dm, [stepOf("fetch", { id: "chat:", to: "bo@example.com" }, {})]), null);
  assert.equal(standsNotice(dm, [stepOf("read_google_chat", { to: "bo@example.com" }, {})]), null);
});

test("(c) a wait on an earlier yes gets the notice with no call, and a held Google Chat send backs it", () => {
  const waiting = "Still waiting on your 👍 from the earlier text before I send it.";
  const question = "send Bo a Google Chat saying the deck is ready";
  assert.equal(standsNotice(waiting, [], question), STANDS_NOTICE);
  assert.equal(standsNotice(waiting, [stepOf("send", { action: "google_chat", to: "bo@example.com", text: "the deck is ready" }, { held: true })], question), null);
});

test("(d) a notes write does not back an email-sent claim", () => {
  const sent = "I already sent the email to Bo.";
  assert.equal(standsNotice(sent, [stepOf("write", { path: "x.md" }, {})]), STANDS_NOTICE);
});

test("negatives: a status question, an honest failure, a fresh preview and a draft listing this turn", () => {
  assert.equal(standsNotice("Is the draft still in your drafts?", []), null, "a question asks, it does not claim");
  assert.equal(standsNotice("I couldn't save the draft: Gmail refused it.", []), null, "an honest failure claims nothing");
  assert.equal(
    standsNotice("Here's the message to Bo. Reply 👍 to send it.", [stepOf("send", { action: "google_chat", to: "bo@example.com", text: "hi" }, { held: true })]),
    null,
    "a fresh preview this turn asks for the yes; it is not a claim",
  );
  const listing = [stepOf("search", { email: true, query: "in:drafts subject:Quarterly plan" }, {})];
  assert.equal(standsNotice("The reply is still saved in your drafts.", listing), null, "a draft listing this turn backs a draft claim");
});

test("the stands gate: one send-back, then fail-closed; a matching act clears it", async () => {
  const gate = standsGate({ question: "" });
  assert.equal(gate.check(INCIDENT), STANDS_NOTICE, "the first unbacked claim is sent back");
  assert.equal(gate.check(INCIDENT), null, "the send-back is given once");
  assert.equal(gate.final(INCIDENT), STANDS_HONEST, "a second unbacked claim after the send-back is replaced, never sent as it is");

  const lastRound = standsGate({ question: "" });
  assert.equal(lastRound.final(INCIDENT), STANDS_HONEST, "a last-round claim, with no check first, is replaced");
  assert.equal(lastRound.final("The meeting is at 3pm."), null, "an answer with no claim goes as it is");
  assert.equal(lastRound.final("   "), null, "an empty answer is left to the turn");

  const acted = standsGate({ question: "" });
  const wrapped = acted.wrap(async () => ({ held: true }));
  await wrapped("send", { action: "google_chat", to: "bo@example.com", text: "hi" });
  assert.equal(acted.final("You're already in that DM with Bo, so I won't send it again."), null, "a held Google Chat send this turn backs it");
});

test("untriedWebCheck no longer runs the stands check, whatever the answer says", () => {
  const check = untriedWebCheck({ question: "" });
  assert.equal(check.check(INCIDENT), null, "the stands gate is composed into every chat turn, not run here");
});

test("the front door gives a console 1:1 no check of its own; texted and group turns keep the untried-web check", () => {
  assert.equal(frontDoorChecks(console1to1), null, "a console 1:1's check is the stands gate");
  assert.equal(frontDoorChecks({ ...console1to1, front: false }), null);
  assert.equal(frontDoorChecks({ ...console1to1, claims: {} }), null);
  assert.equal(frontDoorChecks({ ...console1to1, runner: true }), null);
  assert.equal(frontDoorChecks({ ...console1to1, job: {} }), null);
  assert.equal(frontDoorChecks({ ...console1to1, front: false, client: "other" }), null);

  const texted = frontDoorChecks({ ...console1to1, texted: true, front: false, client: "context_texts" });
  assert.notEqual(texted, null, "a texted turn keeps the untried-web check");
  const group = frontDoorChecks({ ...console1to1, group: {} });
  assert.notEqual(group, null, "a group turn keeps the untried-web check");
  assert.equal(group.check(INCIDENT), null, "the untried-web check does not check stands");
});

test("a texted answer keeps the untried-web check, and it still runs before the stands check", () => {
  const web = { tools: [{ name: "open_page" }], usage: {}, call: async () => ({ content: [{ type: "text", text: "ok" }] }) };
  const check = frontDoorChecks({ ...console1to1, texted: true, front: false, client: "context_texts" });
  check.wrapWeb(web);
  assert.equal(check.check("I couldn't open that page."), TRY_NOTICE);
  assert.equal(check.check("I couldn't open that page."), null, "once a turn");
});

test("the gate is composed before every turn's checks in runTheModel.js (source guards)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/agent/texEntryPoint/runTheModel.js", import.meta.url), "utf8");
  assert.match(source, /const stands = runner \? null : standsGate\(\{ question: askedNow \}\)/, "the gate is built from their ask, not on runner turns");
  assert.match(source, /answerChecksFor\(\{ judge, doIt, claims, tries, chatLog, ledgerAt, stands \}\)/, "every turn's checks get the gate");
  assert.match(source, /stands\?\.wrap/, "every call a turn makes is seen by the gate");
  assert.match(source, /stands\.final\(turn\.answer, \{ exhausted: turn\.exhausted === true, silent \}\)/, "the last answer is checked fail-closed");
});

test("withStands with no checks: an unbacked claim gets the notice, and anything else gets {notice:null}", async () => {
  const unbacked = withStands(standsGate({ question: "" }), null);
  assert.deepEqual(await unbacked.code(INCIDENT, {}), { notice: STANDS_NOTICE, review: false });

  const gate = standsGate({ question: "" });
  const wrapped = gate.wrap(async () => ({ isError: false }));
  await wrapped("save_email_draft", { to: "bo@example.com" });
  assert.deepEqual(await withStands(gate, null).code(INCIDENT, {}), { notice: null, review: false }, "backed by a write this turn");
  assert.deepEqual(await withStands(standsGate({ question: "" }), null).code("The meeting is at 3pm.", {}), { notice: null, review: false });
});

test("withStands: the stands notice comes first, the inner checks run only on a backed answer, and review passes through", async () => {
  const inner = { code: async () => ({ notice: "X", review: true }), review: "R" };
  const unbacked = withStands(standsGate({ question: "" }), inner);
  assert.deepEqual(await unbacked.code(INCIDENT, {}), { notice: STANDS_NOTICE, review: false }, "unbacked: the stands notice goes first");
  assert.equal(unbacked.review, "R", "review is passed through");

  const gate = standsGate({ question: "" });
  const wrapped = gate.wrap(async () => ({ held: true }));
  await wrapped("save_email_draft", { to: "bo@example.com" });
  const backed = withStands(gate, inner);
  assert.deepEqual(await backed.code(INCIDENT, {}), { notice: "X", review: true }, "backed: the inner result comes through");
  assert.equal(backed.review, "R");

  let innerRan = 0;
  const counting = { code: async () => ((innerRan += 1), { notice: null, review: false }), review: null };
  const gateNoted = standsGate({ question: "" });
  await withStands(gateNoted, counting).code(INCIDENT, {});
  assert.equal(innerRan, 0, "the inner checks do not run after a stands notice");
});

test("withStands with no gate passes the checks through unchanged", () => {
  const inner = { code: async () => ({ notice: null, review: false }), review: null };
  assert.equal(withStands(null, inner), inner);
  assert.equal(withStands(null, null), null);
});

// From the second model's review (2026-11-19): ordinary replies the gate must leave alone, and paraphrases it must catch.
test("review: a text to them, a not-yet, a promise to ask first and a wait on their answer are not held back", () => {
  assert.equal(standsNotice("I've already sent you the three options.", [], "send me the options by email"), null, "the text to them is the reply itself");
  assert.equal(standsNotice("I sent you the summary of your messages from today.", [], "summarize my messages"), null);
  assert.equal(standsNotice("Nothing's saved as a draft yet, so tell me if you want one.", [], "draft it"), null);
  assert.equal(standsNotice("I won't send that before you say yes.", [], "email Bo"), null, "a 'before' that looks ahead does not point back");
  assert.equal(standsNotice("Still waiting on your reply on the time. Want me to book it?", [], "book lunch with Bo"), null, "waiting on their answer to a question is not a wait on an earlier yes");
});

test("review: paraphrased still-there claims are claims", () => {
  assert.equal(standsNotice("Your draft's still there.", [], "save the reply as a draft"), STANDS_NOTICE);
  assert.equal(standsNotice("I've put the reply in your drafts.", [], "save the reply as a draft"), STANDS_NOTICE);
});
