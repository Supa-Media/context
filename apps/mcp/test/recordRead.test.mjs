/**
 * An ask about a record is not answered from memory, and a finished write
 * does not grow an extra offer (`recordRead.js`, `finishedOffer.js`).
 *
 * Sabotage: `recordReadNotice` ignoring the calls → "a read this turn lets
 * the answer go" fails. `finishedOfferNotice` matching an email offer →
 * "an offer to send the email is left to the hold" fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FINISHED_OFFER_NOTICE, finishedOfferNotice } from "../src/agent/finishedOffer.js";
import { RECORD_READ_NOTICE, contextNotePath, prefetchNamedRecords, recordAskText, recordReadNotice } from "../src/agent/recordRead.js";
import { untriedWebCheck } from "../src/agent/untriedWeb.js";

const training = (id) => JSON.parse(readFileSync(new URL(`../bench/sets/training/${id}.json`, import.meta.url), "utf8"));
const at = (convo, id) => convo.msgs.findIndex((m) => m.id === id);

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

test("a named note is not read by a search of something else", () => {
  const shop = training("running-the-shop");
  const link = shop.msgs[at(shop, "m37")].text;
  assert.match(link, /^context:\/\//);
  assert.equal(recordReadNotice(link, [{ name: "search_notes", args: { query: "beta" } }]), RECORD_READ_NOTICE);
  assert.equal(recordReadNotice(link, [{ name: "read_note", args: { path: contextNotePath(link) } }]), null);
  const hire = training("trial-hire");
  for (const id of ["m25", "m65"]) {
    const note = hire.msgs[at(hire, id)].text;
    assert.equal(recordReadNotice(note, []), RECORD_READ_NOTICE, id);
    assert.equal(recordReadNotice(note, [{ name: "read_note", args: { path: contextNotePath(note) } }]), null, id);
  }
});

test("Training asks that name no link still have to open the record they are about", () => {
  const hire = training("trial-hire");
  const resume = hire.msgs[at(hire, "m5")].text;
  assert.equal(recordReadNotice(resume, [{ name: "search_notes", args: { query: "resume" } }]), RECORD_READ_NOTICE);
  assert.equal(recordReadNotice(resume, [{ name: "search_email", args: { query: "resume" } }]), null);
  const crew = training("truck-crew");
  const budget = crew.msgs[at(crew, "m31")].text;
  assert.equal(recordReadNotice(budget, [{ name: "search_web", args: { query: "prices" } }]), RECORD_READ_NOTICE);
  assert.equal(recordReadNotice(budget, [{ name: "search_notes", args: { query: "budget" } }]), null);
  const shop = training("running-the-shop");
  const today = shop.msgs[at(shop, "m98")].text;
  assert.equal(recordReadNotice(today, []), RECORD_READ_NOTICE);
  assert.equal(recordReadNotice(today, [{ name: "read_calendar", args: {} }]), null);
  assert.equal(recordReadNotice(hire.msgs[at(hire, "m1")].text, []), null, "a greeting is not a record");
});

test("a short question after a page they just sent is about that page", () => {
  const shop = training("running-the-shop");
  const i = at(shop, "m3");
  const asked = recordAskText(shop.msgs[i].text, shop.msgs[i - 1].text);
  assert.match(asked, /^https:\/\//);
  assert.equal(recordReadNotice(asked, [{ name: "search_notes", args: { query: "walk" } }]), RECORD_READ_NOTICE);
  assert.equal(recordReadNotice(asked, [{ name: "open_page", args: { url: asked.split("\n")[0] } }]), null);
});

test("a named link is opened before the model speaks, and a failed open is not a read", async () => {
  const shop = training("running-the-shop");
  const link = shop.msgs[at(shop, "m37")].text;
  const calls = [];
  const opened = await prefetchNamedRecords(async (name, args) => {
    calls.push([name, args]);
    return { content: [{ type: "text", text: "The beta is invite-only." }] };
  }, link);
  assert.deepEqual(calls, [["read_note", { path: contextNotePath(link) }]]);
  assert.match(opened.preface, /invite-only/);
  assert.equal(recordReadNotice(link, opened.steps), null);
  const failed = await prefetchNamedRecords(async () => ({ isError: true, content: [{ type: "text", text: "no" }] }), link);
  assert.equal(failed.preface, "");
  assert.equal(recordReadNotice(link, failed.steps), RECORD_READ_NOTICE);
});

test("an extra offer is recognised, and an email or a booking offer is not this check", () => {
  assert.equal(finishedOfferNotice("Added. Want me to set up a weekly grocery order too?"), FINISHED_OFFER_NOTICE);
  assert.equal(finishedOfferNotice("Want me to send the email?"), null);
  assert.equal(finishedOfferNotice("All 3 fit. Want me to book it?"), null);
  assert.equal(finishedOfferNotice("Added."), null);
});
