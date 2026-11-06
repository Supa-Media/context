/**
 * A "Re:" email names the email it answers (Dev2, 2026-11-05). Tex sent
 * "Re: Plan recommended, …" to Jo with no in_reply_to, so it went as a new
 * email beside her thread. `readEmail` refuses that in band, and Tex is told
 * to find the email with search_email first.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { REPLY_NEEDS_ID, readEmail } from "../src/tools/email.js";

const BASE = { to: ["jo@example.com"], body: "Hi Jo,\n\nWhere does the review stand?\n\nSeyi" };

test("a Re: subject with no in_reply_to is refused, and says to search_email first", () => {
  for (const subject of ["Re: Plan recommended", "RE: Plan", "  re : plan", "Re:plan"]) {
    const read = readEmail({ ...BASE, subject });
    assert.equal(read.error, REPLY_NEEDS_ID, subject);
    assert.match(read.error, /search_email/);
    assert.match(read.error, /in_reply_to/);
  }
});

test("a Re: subject with in_reply_to goes inside that thread", () => {
  const read = readEmail({ ...BASE, subject: "Re: Plan recommended", in_reply_to: "email:seyi@gmail.example/18c0ffee" });
  assert.equal(read.error, undefined);
  assert.equal(read.email.replyTo, "18c0ffee");
  assert.equal(read.email.from, "seyi@gmail.example");
});

test("a new email, a forward, and a subject that only mentions re are not refused", () => {
  assert.equal(readEmail({ ...BASE, subject: "Plan recommended" }).error, undefined);
  assert.equal(readEmail({ ...BASE, subject: "Regarding the plan" }).error, undefined);
  assert.equal(readEmail({ ...BASE, subject: "Fwd: Re: Plan", forward: "email:seyi@gmail.example/18c0ffee" }).error, undefined);
});

test("a 👍 on a whole email draft reaches the send gate whole, not cut at 500 characters (2026-11-05)", async () => {
  const { quotedOf } = await import("../src/agent/quoted.js");
  const draft = `To: jo@example.com Subject: Plan ${"More of the email body. ".repeat(80)}Thanks, Seyi`;
  assert.ok(draft.length > 1_500);
  assert.equal(quotedOf({ quoted: draft, tapback: "Liked" }).words, draft);
});
