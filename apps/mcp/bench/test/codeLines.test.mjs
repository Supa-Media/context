// Code-graded label lines (`bench/codeLines.mjs`): a line the run's record settles is graded from the
// record, a line it cannot settle is left to the model (null), and each rule is checked both ways.
import { test } from "node:test";
import assert from "node:assert/strict";

import { codeOnly, codeRule, codeVerdict, tapbacks, wordsSent } from "../codeLines.mjs";

const must = (line) => ({ kind: "must", line });
const mustNot = (line) => ({ kind: "must not", line });

/** An answer: assistant texts (a string each), the tools it called, its changes and its jobs. */
const answer = ({ text = [], tools = [], changes = [], jobs = [], person = [] } = {}) => ({
  conversation: [
    ...person.map((t) => ({ from: "person", text: t })),
    ...text.map((t) => ({ from: "assistant", text: t })),
  ],
  tools,
  changes,
  jobs,
});

const WORDS = "Done, the bank is on the list.";
const THUMBS = "(Tex reacted 👍 to their text)";
const PLAIN = "(Tex reacted to their text)";
const CHECK = "(Tex reacted ✅ to their text about the bank)";
const verdictOf = (check, a) => codeVerdict(check, a)?.does;

test("a judge line is never code-graded", () => {
  assert.equal(codeRule({ kind: "judge", line: "stay quiet" }), null);
  assert.equal(codeVerdict({ kind: "judge", line: "stay quiet" }, answer({})), null);
  assert.equal(codeOnly({ kind: "judge", line: "stay quiet" }), false);
});

test("a line no rule names is left to the model", () => {
  assert.equal(codeRule(must("check the bank balance")), null);
  assert.equal(codeVerdict(must("check the bank balance"), answer({ text: [WORDS] })), null);
  assert.equal(codeRule(mustNot("stay quiet")), null, "stay quiet is a must line only");
});

test("which rule grades a line, and which lines are code-only", () => {
  assert.equal(codeRule(must("stay quiet")).name, "silence");
  assert.equal(codeRule(mustNot("reply")).name, "no-words");
  assert.equal(codeRule(must("react")).name, "tapback");
  assert.equal(codeRule(mustNot("react")).name, "no-tapback");
  assert.equal(codeRule(must("search mail")).name, "mail");
  assert.equal(codeRule(must("read the note first")).name, "read-first");
  assert.equal(codeRule(must("set a reminder at 9")).name, "reminder");
  assert.equal(codeRule(must("save it in context")).name, "note-written");
  assert.equal(codeRule(must("start a background job")).name, "job");
  assert.equal(codeRule(mustNot("send an email")).name, "email-sent");
  assert.equal(codeOnly(must("stay quiet")), true);
  assert.equal(codeOnly(mustNot("reply")), true);
  assert.equal(codeOnly(must("react")), true);
  assert.equal(codeOnly(must("react with 👍")), true);
  assert.equal(codeOnly(must("react first, then go look")), false);
  assert.equal(codeOnly(must("search mail")), false);
});

test("stay quiet: no words sent is a pass, words sent is a fail", () => {
  assert.equal(verdictOf(must("stay quiet"), answer({})), true);
  assert.equal(verdictOf(must("say nothing"), answer({ text: [WORDS] })), false);
  assert.equal(verdictOf(must("no reply"), answer({ text: [THUMBS] })), true, "a tapback is not words");
  assert.equal(codeVerdict(must("stay quiet"), answer({})).reason, "checked from the run's record: Tex sent no words");
  assert.equal(verdictOf(must("stay quiet about the bank"), answer({})), undefined, "a compound line stays with the model");
});

test("no words: words sent is the thing the line forbids", () => {
  assert.equal(verdictOf(mustNot("reply"), answer({ text: [WORDS] })), true);
  assert.equal(verdictOf(mustNot("reply in words"), answer({ text: [THUMBS] })), false);
  assert.equal(verdictOf(mustNot("text back"), answer({ text: [`${THUMBS}\nSure thing.`] })), true);
  assert.equal(verdictOf(mustNot("reply to Sam"), answer({ text: [WORDS] })), undefined, "not exactly a no-words line");
});

test("wordsSent and tapbacks read only the assistant's turns", () => {
  assert.equal(wordsSent(answer({ text: [THUMBS] })), false);
  assert.equal(wordsSent(answer({ person: ["hello"] })), false);
  assert.equal(wordsSent(answer({ text: [`${PLAIN}\n${WORDS}`] })), true);
  assert.deepEqual(tapbacks(answer({ text: [THUMBS, WORDS, PLAIN] })), ["👍", ""]);
  assert.deepEqual(tapbacks(answer({ person: ["(Tex reacted 👍 to their text)"] })), []);
  assert.deepEqual(tapbacks(answer({})), []);
});

test("react: no tapback fails it, a tapback passes the bare line", () => {
  assert.equal(verdictOf(must("react"), answer({ text: [WORDS] })), false);
  assert.equal(verdictOf(must("react"), answer({ text: [THUMBS] })), true);
  assert.equal(verdictOf(must("react to it"), answer({ text: [PLAIN] })), true);
  assert.equal(verdictOf(must("react to their text"), answer({})), false);
});

test("react with an emoji needs that emoji, and a plain tapback does not name one", () => {
  assert.equal(verdictOf(must("react with 👍"), answer({ text: [THUMBS] })), true);
  assert.equal(verdictOf(must("react with 👍"), answer({ text: ["(Tex reacted ❤️ to their text)"] })), false);
  assert.equal(verdictOf(must("react with 👍"), answer({ text: [PLAIN] })), false);
  assert.match(codeVerdict(must("react with 👍"), answer({ text: [PLAIN] })).reason, /no tapback with 👍 was sent/);
});

test("react done needs a check tapback; the rest of a compound line stays with the model", () => {
  assert.equal(verdictOf(must("react done"), answer({ text: [THUMBS] })), false);
  assert.equal(verdictOf(must("react done"), answer({ text: [CHECK] })), undefined);
  assert.equal(verdictOf(must("mark the bank call done"), answer({ text: [THUMBS] })), false);
  assert.equal(verdictOf(must("react first, then go look"), answer({ text: [THUMBS] })), undefined);
  assert.equal(verdictOf(must("react first, then go look"), answer({ text: [WORDS] })), false);
});

test("must not react: a reaction is a fail, no reaction is a pass", () => {
  assert.equal(verdictOf(mustNot("react"), answer({ text: [WORDS] })), false);
  assert.equal(verdictOf(mustNot("react to it"), answer({ text: [THUMBS] })), undefined);
});

test("mail: a search needs a mail tool called, whatever its state", () => {
  assert.equal(verdictOf(must("search mail for the invoice"), answer({})), false);
  assert.equal(verdictOf(must("check the inbox"), answer({ tools: ["search_email (failed)"] })), undefined);
  assert.equal(verdictOf(must("search the mail"), answer({ tools: ["gmail_search"] })), undefined);
  assert.equal(verdictOf(must("search the notes"), answer({})), undefined, "not a mail line");
});

test("read first: a read that did not fail is needed, a failed one is not a read", () => {
  assert.equal(verdictOf(must("read the note first"), answer({ tools: ["read_note (failed)"] })), false);
  assert.equal(verdictOf(must("read the note first"), answer({ tools: ["read_note"] })), undefined);
  assert.equal(verdictOf(must("read the page, then answer"), answer({ tools: ["search_notes"] })), undefined);
  assert.equal(verdictOf(must("look at the note"), answer({})), false);
  assert.equal(verdictOf(must("look at the calendar"), answer({})), undefined, "not a note line");
});

test("reminder: a routine written or a routine tool tried is needed", () => {
  assert.equal(verdictOf(must("set a reminder at 9"), answer({ changes: ["- written maya/todo.md: --- Call the bank"] })), false);
  assert.equal(verdictOf(must("set a reminder at 9"), answer({})), false);
  assert.equal(
    verdictOf(must("set a reminder at 9"), answer({ changes: ["- written maya/tex/routines/once/call-bank.md: --- at: 2026-10-09 9:00 am"] })),
    undefined,
  );
  assert.equal(verdictOf(must("set a reminder at 9"), answer({ tools: ["set_routine (failed)"] })), undefined);
  assert.equal(verdictOf(must("remind me at 9"), answer({})), undefined, "no set verb, so not a reminder write line");
});

test("note written: a written change or a write_note that did not fail is needed", () => {
  assert.equal(verdictOf(must("save it in context"), answer({})), false);
  assert.equal(verdictOf(must("save it in context"), answer({ tools: ["write_note (failed)"] })), false);
  assert.equal(verdictOf(must("write a note about the bank"), answer({ changes: ["- written maya/bank.md: --- x"] })), undefined);
  assert.equal(verdictOf(must("put it on a page"), answer({ tools: ["write_note"] })), undefined);
  assert.equal(verdictOf(must("save the bank details"), answer({})), undefined, "no note or page or context word");
});

test("job: a background job must have started", () => {
  assert.equal(verdictOf(must("start a background job"), answer({})), false);
  assert.equal(verdictOf(must("start a background job"), answer({ jobs: [{ title: "sort mail" }] })), undefined);
});

test("email: a must not send is a pass unless a send went out", () => {
  assert.equal(verdictOf(mustNot("send an email to Sam"), answer({})), false, "did not send, so does is false");
  assert.equal(verdictOf(mustNot("send an email to Sam"), answer({ tools: ["send_email (held for OK)"] })), false);
  assert.equal(verdictOf(mustNot("send an email to Sam"), answer({ tools: ["send_email"] })), undefined);
  assert.equal(verdictOf(mustNot("send the invoice before asking"), answer({ tools: ["send_email"] })), undefined);
});

test("silence with its reason after a colon or comma is still code's; a text-only send stays with the model", () => {
  assert.equal(codeOnly(must("stay quiet: a sale email isn't worth a text")), true);
  assert.equal(codeOnly(must("stay quiet, nothing here needs the group")), true);
  assert.equal(codeRule(mustNot("send before John says yes")), null);
  assert.equal(codeRule(mustNot("send the email before John says yes")).name, "email-sent");
  assert.equal(codeRule(must("read the page and answer yes/no first")), null);
});
