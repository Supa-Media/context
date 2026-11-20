/**
 * The app chat's cards (`packages/tex/gateway/agent/appChatCards.js`): an ask's text read back into a card. Every ask
 * text here is built by the real `askLine` from a record the real `emailCopy` wrote, so the parser is tested against
 * the format the gateway actually sends, not a copy of it.
 *
 * Runs as `test/run.mjs` does (`test/unit.list`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cardOf, parseAskEmail } from "../../../packages/tex/gateway/agent/appChatCards.js";
import { askLine } from "../../../packages/tex/gateway/agent/textedApprovals.js";
import { EMAIL_TOOL, emailCopy } from "../src/tools/email.js";

const NOW = 1_800_000_000_000;
const EMAIL = { from: "a@x.com", to: ["b@y.com"], cc: [], subject: "Hi", body: "Hello there.\n\nSecond paragraph." };
/** The ask `askLine` puts to the person for one held email, built from the copy `emailCopy` writes for it. */
const askFor = (email, { forward = null, attached = [], who } = {}) =>
  askLine([{ id: "rec1", tool: EMAIL_TOOL, detail: emailCopy(email, forward, attached) }], who ? { who } : {});
/** The live approval record an email ask holds (`tools/approvals.js`), its args as `email.js` builds them. */
const sendRecord = (args, extra = {}) => ({ id: "rec1", tool: EMAIL_TOOL, args, summary: "send an email", detail: emailCopy({ ...args, from: args.from ?? null, cc: args.cc ?? [] }), ...extra });

describe("parseAskEmail reads the ask askLine writes for one email", () => {
  it("reads the sender, recipients, subject and body back out of the real ask line", () => {
    assert.deepEqual(parseAskEmail(askFor(EMAIL)), { from: "a@x.com", to: "b@y.com", cc: "", subject: "Hi", thread: false, body: "Hello there.\n\nSecond paragraph." });
  });

  it("joins several recipients and copies, and marks a reply inside its thread", () => {
    const reply = { ...EMAIL, to: ["b@y.com", "c@y.com"], cc: ["d@z.com", "e@z.com"], replyTo: "msg-1" };
    const parsed = parseAskEmail(askFor(reply));
    assert.equal(parsed.to, "b@y.com, c@y.com");
    assert.equal(parsed.cc, "d@z.com, e@z.com");
    assert.equal(parsed.thread, true);
  });

  it("keeps an empty body, and a body whose lines look like the yes line's neighbours", () => {
    assert.equal(parseAskEmail(askFor({ ...EMAIL, body: "" })).body, "");
    const tricky = "Sure.\n\n\n\nGive it a 👍 is what I say in the middle.\nFrom: not a header";
    assert.equal(parseAskEmail(askFor({ ...EMAIL, body: tricky })).body, tricky);
  });

  it("reads a group's ask, which names whose account it goes from", () => {
    const parsed = parseAskEmail(askFor(EMAIL, { who: "seyi" }));
    assert.equal(parsed.from, "a@x.com");
    assert.equal(parsed.body, EMAIL.body);
  });

  it("reads an ask with no sender line as a null sender", () => {
    assert.equal(parseAskEmail(askFor({ ...EMAIL, from: undefined })).from, null);
  });

  it("is null for an ask of several emails", () => {
    const two = askLine([
      { id: "a", tool: EMAIL_TOOL, detail: emailCopy(EMAIL) },
      { id: "b", tool: EMAIL_TOOL, detail: emailCopy({ ...EMAIL, subject: "Second" }) },
    ]);
    assert.equal(parseAskEmail(two), null);
  });

  it("is null for an email with a forwarded email or attachments, which are not editable cards", () => {
    const forwarded = { messageId: "m2", from: "c@z.com", subject: "Old", attachments: [] };
    assert.equal(parseAskEmail(askFor({ ...EMAIL, forward: "m2" }, { forward: forwarded })), null);
    assert.equal(parseAskEmail(askFor(EMAIL, { attached: ["report.pdf"] })), null);
  });

  it("is null for an ask that is not an email, and for anything that is not an ask", () => {
    const other = askLine([{ id: "x", tool: "some_tool", summary: "do a thing", detail: null }]);
    assert.equal(parseAskEmail(other), null);
    assert.equal(parseAskEmail("hello there"), null);
    assert.equal(parseAskEmail(undefined), null);
  });
});

describe("cardOf for a live email", () => {
  it("is an editable email card, waiting, from the record's args", () => {
    const card = cardOf({ record: sendRecord({ from: "a@x.com", to: ["b@y.com"], cc: [], subject: "Hi", body: "Hello", replyTo: "m1" }), now: NOW });
    assert.deepEqual(card, { kind: "email", state: "wait", from: "a@x.com", to: "b@y.com", cc: "", subject: "Hi", thread: true, body: "Hello", editable: true });
  });

  it("takes the sender from the copy's first line when the args name none, and the first of a list of senders", () => {
    assert.equal(cardOf({ record: sendRecord({ to: ["b@y.com"], cc: [], subject: "Hi", body: "x" }, { detail: "From: d@w.com\nTo: b@y.com\nSubject: Hi\n\nx" }), now: NOW }).from, "d@w.com");
    assert.equal(cardOf({ record: sendRecord({ from: ["e@v.com", "f@v.com"], to: ["b@y.com"], cc: [], subject: "Hi", body: "x" }), now: NOW }).from, "e@v.com");
  });

  it("is held when the chat kept it held, and still editable", () => {
    const card = cardOf({ record: sendRecord({ to: ["b@y.com"], cc: [], subject: "Hi", body: "x" }), kept: { state: "held", at: NOW - 5 }, now: NOW });
    assert.equal(card.state, "held");
    assert.equal(card.editable, true);
    assert.equal(card.at, NOW - 5);
  });

  it("is sending while the yes is recent, and then shows as waiting, not editable while sending", () => {
    const record = sendRecord({ to: ["b@y.com"], cc: [], subject: "Hi", body: "x" });
    const recent = cardOf({ record, kept: { state: "sending", at: NOW - 1_000 }, now: NOW });
    assert.equal(recent.state, "sending");
    assert.equal(recent.editable, false);
    assert.equal(cardOf({ record, kept: { state: "sending", at: NOW - 121_000 }, now: NOW }).state, "wait");
  });

  it("is not editable when it is answered in a chat", () => {
    assert.equal(cardOf({ record: sendRecord({ to: ["b@y.com"], cc: [], subject: "Hi", body: "x" }, { chat_key: "group:1" }), now: NOW }).editable, false);
  });

  it("is an other card with its summary and detail when it has a forward or attachments", () => {
    const card = cardOf({ record: sendRecord({ to: ["b@y.com"], cc: [], subject: "Hi", body: "x", attach: ["f1"] }), now: NOW });
    assert.equal(card.kind, "other");
    assert.equal(card.summary, "send an email");
    assert.match(card.detail, /^To: b@y\.com/);
    assert.equal("editable" in card, false);
  });

  it("is an other card for a record that is not an email, with always set only for a vault use", () => {
    const calendar = cardOf({ record: { id: "c", tool: "calendar", summary: "move a meeting", detail: null }, now: NOW });
    assert.deepEqual(calendar, { kind: "other", state: "wait", summary: "move a meeting", detail: null });
    const vault = cardOf({ record: { id: "v", tool: "vault", kind: "vault_use", summary: "use a card", detail: "at a shop" }, now: NOW });
    assert.equal(vault.always, true);
    assert.equal(vault.detail, "at a shop");
  });
});

describe("cardOf once the approval is gone", () => {
  const ask = askFor(EMAIL);

  it("is a sent email card with the words from the ask, when the chat kept it sent", () => {
    const card = cardOf({ record: null, kept: { state: "sent", at: NOW - 9 }, askText: ask, now: NOW });
    assert.equal(card.kind, "email");
    assert.equal(card.state, "sent");
    assert.equal(card.at, NOW - 9);
    assert.equal(card.to, "b@y.com");
    assert.equal(card.editable, false);
  });

  it("is sent when the approval settled approved within the hour, even with nothing kept", () => {
    const card = cardOf({ record: null, kept: undefined, askText: ask, now: NOW, done: true });
    assert.equal(card.state, "sent");
    assert.equal(card.at, undefined);
  });

  it("is gone when nothing says it was sent", () => {
    const card = cardOf({ record: null, kept: { state: "held", at: NOW - 3 }, askText: ask, now: NOW });
    assert.equal(card.state, "gone");
  });

  it("shows the body the person kept when they edited it", () => {
    const card = cardOf({ record: null, kept: { state: "sent", at: NOW, body: "Edited words" }, askText: ask, now: NOW });
    assert.equal(card.body, "Edited words");
  });

  it("is an other card of the ask's first line when the ask is not one email", () => {
    const text = "Before I do that, I need your OK: move a meeting. Give it a 👍 and I'll go ahead.";
    assert.deepEqual(cardOf({ record: null, kept: { state: "sent", at: NOW }, askText: text, now: NOW }), { kind: "other", state: "sent", summary: text, detail: null, at: NOW });
  });

  it("is null when there is neither a live record nor the ask's text", () => {
    assert.equal(cardOf({ record: null, kept: undefined, askText: undefined, now: NOW }), null);
  });
});

describe("cardOf caps what it shows", () => {
  it("cuts a body or detail at 24,000 characters and a subject or address at 500", () => {
    const card = cardOf({ record: sendRecord({ to: ["b@y.com"], cc: [], subject: "s".repeat(600), body: "b".repeat(30_000) }), now: NOW });
    assert.equal(card.body.length, 24_000);
    assert.equal(card.subject.length, 500);
    const other = cardOf({ record: { id: "c", tool: "calendar", summary: "x", detail: "d".repeat(30_000) }, now: NOW });
    assert.equal(other.detail.length, 24_000);
  });
});
