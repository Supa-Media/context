/**
 * Sending as a mailbox's "Send mail as" address (Dev2, 2026-11-26: seyi@… answering as reception@…), gateway side.
 *
 * The control plane decides whether an address is one of the mailbox's (`apps/convex/functions/lib/gmailSendAs.ts`,
 * `personEmail.test.ts`); this side only carries the From and the mailbox holding a reply's email, and tells the turn
 * each mailbox's aliases as data.
 *
 * Sabotage record: put back "A reply goes from the mailbox the email is in" in `readEmail` → the first test fails;
 * drop `sendsAs` from `listed` in `mailAccounts.js` → the second fails; drop it from `chatMailOf` → the third fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { REFUSED, emailCopy, readEmail } from "../src/tools/email.js";
import { mailAccountsPrompt } from "../../../packages/tex/gateway/agent/mailAccounts.js";
import { chatMailOf, chatMailPrompt } from "../../../packages/tex/gateway/agent/groupMail.js";

const BASE = { to: ["jo@example.invalid"], subject: "Re: Start of care", body: "Hi Jo,\n\nThanks.\n" };

test("a reply from an alias goes through the mailbox its email is in, from the alias the person is shown", () => {
  const read = readEmail({ ...BASE, from: "Reception@Practice.example", in_reply_to: "email:seyi@practice.example/18cafe" });
  assert.equal(read.error, undefined);
  assert.equal(read.email.from, "reception@practice.example");
  assert.equal(read.email.mailbox, "seyi@practice.example");
  assert.equal(read.email.replyTo, "18cafe");
  assert.match(emailCopy(read.email), /^From: reception@practice\.example\n/);
  // From the mailbox itself, or none named: no mailbox beside it, as before.
  const own = readEmail({ ...BASE, from: "seyi@practice.example", in_reply_to: "email:seyi@practice.example/18cafe" });
  assert.equal(own.email.mailbox, undefined);
  assert.equal(readEmail({ ...BASE, in_reply_to: "email:seyi@practice.example/18cafe" }).email.from, "seyi@practice.example");
  const forward = readEmail({ ...BASE, subject: "Fwd: x", from: "reception@practice.example", forward: "email:seyi@practice.example/18rcpt" });
  assert.equal(forward.email.mailbox, "seyi@practice.example");
  // A new email from an alias names no mailbox: the control plane finds the one it is on.
  assert.equal(readEmail({ ...BASE, subject: "Hello", from: "reception@practice.example" }).email.mailbox, undefined);
  assert.match(REFUSED.not_their_address, /^Not sent: /);
});

test("a turn is told each mailbox's send-as addresses, as data beside it", () => {
  const said = mailAccountsPrompt([
    { address: "seyi@practice.example", state: "ok", sendsAs: ["Reception@Practice.example", "not an address"] },
    { address: "old@example.com", state: "ok", readOnly: true, sendsAs: ["x@example.com"] },
  ]);
  assert.match(said, /seyi@practice\.example \[send as: reception@practice\.example\]/);
  assert.ok(!said.includes("not an address"));
  assert.ok(!said.includes("x@example.com"), "a read-only mailbox sends as nothing");
});

test("a group chat's shared mailbox carries its send-as addresses into the prompt", () => {
  const mail = chatMailOf([{ handle: "seyi", address: "seyi@practice.example", sendsAs: ["reception@practice.example", 7] }]);
  assert.deepEqual(mail, [{ handle: "seyi", address: "seyi@practice.example", sendsAs: ["reception@practice.example"] }]);
  assert.match(chatMailPrompt({ mail }), /@seyi's seyi@practice\.example \[send as: reception@practice\.example\]/);
});
