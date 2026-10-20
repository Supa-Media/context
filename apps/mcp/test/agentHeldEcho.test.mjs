import assert from "node:assert/strict";
import { test } from "node:test";

import { withoutHeldEcho } from "../src/agent/heldEcho.js";

const COPY =
  "From: seyi@example.com\nTo: luciana@example.com\nSubject: RE: Bowling, 11.06.26\n\nHi Luciana,\n\n" +
  "Thanks for following up. We'd like to go with the October 30th option instead, on Friday, October 30 at 7:00 pm.\n\n" +
  "Could you send over a link where we can pay the deposit to lock in the date?\n\nThanks,\nSeyi";
const held = [{ tool: "send_email", detail: COPY }];

test("the answer Tex texted on 2026-10-19 keeps only what is not the email", () => {
  const answer = [
    "The email didn't go through on my end, so here it is to send yourself. Reply on her Lucky Strike thread:",
    "To: Luciana@Example.com\nSubject: RE: Bowling, 11.06.26",
    "Hi Luciana, thanks for following up. We'd like to go with the October 30th option, Friday, October 30 at 7:00 pm. Could you send over a link where we can pay the deposit to lock in the date? Thanks, Seyi",
    "I didn't say 1.5 or 2 hours. Her quotes were for 6:30, so she may send a new one for 7:00.",
  ].join("\n\n");
  assert.equal(withoutHeldEcho(answer, held), "I didn't say 1.5 or 2 hours. Her quotes were for 6:30, so she may send a new one for 7:00.");
});

test("a line about the email, and anything else, stays", () => {
  const answer = "Asked her for a link where we can pay the deposit to lock in the date.\n\nShe also wants the shoe count.";
  assert.equal(withoutHeldEcho(answer, held), answer);
});

test("nothing is touched when no email was held", () => {
  const answer = "To: whoever\n\nHere's the draft to send yourself.";
  assert.equal(withoutHeldEcho(answer, []), answer);
  assert.equal(withoutHeldEcho(answer, [{ tool: "calendar_event", detail: "To: x" }]), answer);
});

test("an answer that was only the copy becomes empty, so the ask goes alone", () => {
  assert.equal(withoutHeldEcho("Here it is:\n\nSubject: RE: Bowling\n\nHi Luciana, thanks for following up. We'd like to go with the October 30th option instead, on Friday, October 30 at 7:00 pm.", held), "");
});
