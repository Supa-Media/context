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

import { claimCheck } from "../src/agent/claimCheck.js";
import { FINISHED_OFFER_NOTICE, finishedOfferNotice } from "../src/agent/finishedOffer.js";
import { RECORD_READ_NOTICE, recordReadNotice } from "../src/agent/recordRead.js";

test("an ask about a note, with no read, is sent back; a read lets it go", () => {
  assert.equal(recordReadNotice("what does the note say about the trip", []), RECORD_READ_NOTICE);
  assert.equal(recordReadNotice("what does the note say about the trip", [{ name: "search_notes", ok: true }]), null);
  assert.equal(recordReadNotice("what's the capital of Portugal", []), null, "general knowledge is not a record");
  assert.equal(recordReadNotice("thanks", []), null);
});

test("the same check runs on the turn's answer check", async () => {
  const unread = claimCheck({ question: "what does my email from Paulo say" });
  assert.match(String(await unread.check("Paulo says the ceremony is at 4.")), /have not read any of it/);
  const read = claimCheck({ question: "what does my email from Paulo say" });
  await read.wrap(async () => ({ content: [{ type: "text", text: "From Paulo: ceremony at 4." }] }))("search_email", { query: "Paulo" });
  assert.equal(await read.check("Paulo says the ceremony is at 4."), null);
});

test("a finished write that still offers more is sent back; an email offer is not", async () => {
  assert.equal(finishedOfferNotice("Added. Want me to set up a weekly grocery order too?"), FINISHED_OFFER_NOTICE);
  assert.equal(finishedOfferNotice("Want me to send the email?"), null);
  assert.equal(finishedOfferNotice("Added."), null);
  const done = claimCheck({ question: "add oat milk to the list" });
  await done.wrap(async () => ({ content: [] }))("write_note", { path: "todo.md", content: "- oat milk" });
  assert.match(String(await done.check("Added. Want me to set up a weekly grocery order too?")), /Don't add an offer/);
  const recommend = claimCheck({ question: "which flight" });
  assert.equal(await recommend.check("Take the nonstop. Want me to book it?"), null, "no write yet: the offer can be the next step");
});
