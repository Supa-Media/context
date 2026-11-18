/**
 * An ask about a record is not answered from memory, and a finished write
 * does not grow an extra offer (`recordRead.js`, `finishedOffer.js`).
 *
 * Sabotage: `recordReadNotice` ignoring the calls → "a read this turn lets
 * the answer go" fails. `finishedOfferNotice` matching an email offer →
 * "an offer to send the email is left to the hold" fails.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FINISHED_OFFER_NOTICE, finishedOfferNotice } from "../src/agent/finishedOffer.js";
import { RECORD_READ_NOTICE, recordReadNotice } from "../src/agent/recordRead.js";
import { untriedWebCheck } from "../src/agent/untriedWeb.js";

test("an ask to read a note, with no read, is sent back; a mention is not", () => {
  assert.equal(recordReadNotice("what does the note say about the trip", []), RECORD_READ_NOTICE);
  assert.equal(recordReadNotice("what does the note say about the trip", [{ name: "search_notes", ok: true }]), null);
  assert.equal(recordReadNotice("what's the capital of Portugal", []), null, "general knowledge is not a record");
  assert.equal(recordReadNotice("If nothing needs the chat, answer exactly SKIP.", []), null, "a check-in mentioning the chat is not an ask to read it");
  assert.equal(recordReadNotice("find catering for 30 people, in a plain note", []), null, "naming a note as where to write is not an ask to read one");
  assert.equal(
    recordReadNotice("every morning at 7:30 tell me what's due, and note the tulips in a plain note", []),
    null,
    "note as a verb, and a plain note to write, is not an ask to read one",
  );
  assert.equal(recordReadNotice("check the status page and share fourth", []), null, "a status page is not their page");
  assert.equal(recordReadNotice("check my email", []), RECORD_READ_NOTICE);
  assert.equal(recordReadNotice("read the page about the trip", []), RECORD_READ_NOTICE);
});

test("the front door's check sends a record ask back, and lets it go after a read", async () => {
  const unread = untriedWebCheck({ question: "what does my email from Paulo say" });
  assert.match(String(unread.check("Paulo says the ceremony is at 4.")), /have not read any of it/);
  const read = untriedWebCheck({ question: "what does my email from Paulo say" });
  await read.wrap(async () => ({ content: [{ type: "text", text: "From Paulo: ceremony at 4." }] }))("search_email", { query: "Paulo" });
  assert.equal(read.check("Paulo says the ceremony is at 4."), null);
});

test("an extra offer is recognised, and an email or a booking offer is not this check", () => {
  assert.equal(finishedOfferNotice("Added. Want me to set up a weekly grocery order too?"), FINISHED_OFFER_NOTICE);
  assert.equal(finishedOfferNotice("Want me to send the email?"), null);
  assert.equal(finishedOfferNotice("All 3 fit. Want me to book it?"), null);
  assert.equal(finishedOfferNotice("Added."), null);
});
