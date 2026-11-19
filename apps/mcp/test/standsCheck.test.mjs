/**
 * AN ANSWER THAT SAYS IT IS STILL THERE NEEDS A LOOK IN THIS TURN (2026-11-19;
 * `src/agent/standsCheck.js`). A console 1:1 was asked to save a Gmail reply
 * as a draft and not send it; Tex ran no tool and said "I already did this at
 * 1:31 PM … The reply is saved as a Gmail draft", and the draft was gone.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `frontDoorChecks` returning null for the console case: "a console 1:1
 *    gets the stands check" and "the wiring is in prepareTheAnswer" fail;
 *  - the "already" patterns removed from `ALREADY`: "I already did this" and
 *    "it's already in your drafts" stop being claims and their tests fail.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { TRY_NOTICE } from "../src/agent/claimCheck.js";
import { frontDoorChecks, untriedWebCheck } from "../src/agent/untriedWeb.js";
import { STANDS_NOTICE, checkedThisTurn, claimsItStands, standsCheck, standsNotice } from "../src/agent/standsCheck.js";

const INCIDENT = "I already did this at 1:31 PM. The reply is saved as a Gmail draft in your account. Nothing was sent.";
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

test("a claim with no call in the turn gets the notice, and a turn that checked it does not", () => {
  assert.equal(standsNotice(INCIDENT, []), STANDS_NOTICE);
  assert.equal(standsNotice(INCIDENT, [{ name: "search", ok: true, args: { query: "notes" } }]), STANDS_NOTICE, "a notes search is not a fresh check");
  assert.equal(standsNotice(INCIDENT, [{ name: "save_email_draft", ok: false }]), STANDS_NOTICE, "a write that failed is not done");
  assert.equal(standsNotice(INCIDENT, [{ name: "save_email_draft", ok: true }]), null);
  assert.equal(standsNotice(INCIDENT, [{ name: "send", ok: true, action: "email_draft" }]), null);
  assert.equal(standsNotice(INCIDENT, [{ name: "send_email", ok: false, held: true }]), null, "a held change is checked");
  assert.equal(standsNotice(INCIDENT, [{ name: "search_email", ok: true }]), null);
  assert.equal(standsNotice(INCIDENT, [{ name: "search", ok: true, args: { query: "in:drafts lumber" } }]), null);
  assert.equal(standsNotice("The meeting is at 3pm.", []), null, "no claim, no notice");
  assert.equal(checkedThisTurn([{ name: "fetch", ok: true, args: { url: "https://example.com/" } }]), false);
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

test("the untried-web check runs the stands check with no tools run", () => {
  const check = untriedWebCheck({ question: "" });
  assert.equal(check.check("I already did this at 1:31 PM. The reply is saved as a Gmail draft."), STANDS_NOTICE);
});

test("the front door gets the stands check on a console 1:1, and not on a turn with a job or a runner", () => {
  const front = frontDoorChecks(console1to1);
  assert.notEqual(front, null);
  assert.equal(front.check(INCIDENT), STANDS_NOTICE);

  assert.notEqual(frontDoorChecks({ ...console1to1, front: false }), null);
  assert.equal(frontDoorChecks({ ...console1to1, claims: {} }), null);
  assert.equal(frontDoorChecks({ ...console1to1, runner: true }), null);
  assert.equal(frontDoorChecks({ ...console1to1, job: {} }), null);
  assert.equal(frontDoorChecks({ ...console1to1, front: false, client: "other" }), null);

  const texted = frontDoorChecks({ ...console1to1, texted: true, front: false, client: "context_texts" });
  assert.equal(texted.check(INCIDENT), STANDS_NOTICE);

  const group = frontDoorChecks({ ...console1to1, group: {} });
  assert.notEqual(group, null);
  assert.equal(group.check(INCIDENT), STANDS_NOTICE);
});

test("a texted answer keeps the untried-web check, and it still runs before the stands check", () => {
  const web = { tools: [{ name: "open_page" }], usage: {}, call: async () => ({ content: [{ type: "text", text: "ok" }] }) };
  const check = frontDoorChecks({ ...console1to1, texted: true, front: false, client: "context_texts" });
  check.wrapWeb(web);
  assert.equal(check.check("I couldn't open that page."), TRY_NOTICE);
  assert.equal(check.check("I couldn't open that page."), null, "once a turn");
});

test("prepareTheAnswer wires the front-door checks, so the wiring cannot be dropped silently", () => {
  const source = readFileSync(new URL("../src/agent/texEntryPoint/prepareTheAnswer.js", import.meta.url), "utf8");
  assert.match(source, /const tries = frontDoorChecks\(/);
  assert.match(source, /import \{ frontDoorChecks \} from "\.\.\/untriedWeb\.js"/);
});

test("paraphrases and mixed answers: a claim is a claim, a not-yet is not, and a mail look is a whole word", () => {
  assert.equal(claimsItStands("The vendor reply is sitting in your drafts."), true, "sitting in your drafts, with no still or already");
  assert.equal(claimsItStands("I already did this earlier. I couldn't see the attachment, though."), true, "a failure elsewhere does not hide an already-done claim");
  assert.equal(claimsItStands("Nothing was sent yet. Want me to save it as a draft?"), false, "nothing sent yet is not a claim");
  assert.equal(standsNotice("The reply is saved as a draft.", [{ name: "search", ok: true, args: { query: "present for Ana" } }]), STANDS_NOTICE, "a notes search for 'present' is not a look at sent mail");
  assert.equal(standsNotice("The reply is saved as a draft.", [{ name: "fetch", ok: true, args: { id: "https://mailchimp.example/x" } }]), STANDS_NOTICE, "a mailchimp page is not their mail");
});
