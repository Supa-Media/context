/**
 * THE ADVISOR'S ASKS, THE MAIL CHECKER'S VERDICTS AND JOBS IN THE CHAT'S
 * LEDGER (`src/agent/workEntries.js`): written beside the turn's own entries,
 * read back from the chat's Tex object, never a second copy.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `settledMail` writing "sent" on a failed replay. → "a held email
 *     settled: sent on a yes, stopped on a no or a failed send" fails.
 *  2. `recordMail` keeping a held email under a fresh id. → "a texted email's
 *     check is read back from the chat's ledger, and its yes names it" fails.
 *  3. `advisorTools` not telling `record`. → "an advisor ask is told with the
 *     model's own words and what it read" fails.
 *  4. `jobChecked` writing nothing for the advisor's verdict. → "a job's check
 *     by the advisor" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { advisorEntry, advisorRecorder, heldCheckId, jobChecked, jobEntry, mailEntry, mailVerdict, recordMail, settledMail, startedJobEntries } from "../src/agent/workEntries.js";
import { advisorTools } from "../src/agent/advisor.js";
import { ledgerFor } from "../src/agent/ledger.js";
import { settlePending, createPending } from "../src/tools/approvals.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { ask, createEgressWorld, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

function fakeLedger() {
  const entries = [];
  return { entries, write: (list) => void entries.push(...(Array.isArray(list) ? list : [list]).filter(Boolean)), flush: async () => {} };
}

test("entries carry the ledger's envelope and only the turn ids it takes", () => {
  const advice = advisorEntry({ question: "Book or ask?", answer: "Ask.", steps: 2, ms: 900.4 }, { turn: "turn_0123456789", job: "Trip" });
  assert.equal(advice.v, 1);
  assert.equal(advice.kind, "advisor");
  assert.match(advice.id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual({ ...advice, id: "", at: 0 }, { v: 1, id: "", at: 0, kind: "advisor", turn: "turn_0123456789", job: "Trip", question: "Book or ask?", answer: "Ask.", steps: 2, ms: 900 });
  assert.equal(advisorEntry({ question: "q", answer: "a" }, { turn: "bad turn id" }).turn, undefined, "a malformed turn id is left out");
  const mail = mailEntry({ to: ["jo@example.com"], cc: ["al@example.com"], subject: "Trip" }, { verdict: "waiting", why: "Waiting for their yes", ask: "0f-1" });
  assert.deepEqual({ ...mail, id: "", at: 0 }, { v: 1, id: "", at: 0, kind: "mail_check", to: "jo@example.com, al@example.com", subject: "Trip", verdict: "waiting", why: "Waiting for their yes", from: "your texts", ask: "0f-1" });
  assert.deepEqual({ ...jobEntry({ id: "job-1", title: "Trip" }, "started"), id: "", at: 0 }, { v: 1, id: "", at: 0, kind: "job", job: "job-1", title: "Trip", state: "started" });
  assert.deepEqual(startedJobEntries([{ id: "j1", title: "A" }, { title: "no id" }]).map((entry) => entry.job), ["j1"], "only jobs the Worker runs by a known id");
  assert.equal(heldCheckId("6f1c-22ab"), "mc6f1c22ab");
});

test("what a mail check's verdict reads as", () => {
  assert.deepEqual(mailVerdict({ verdict: "no", reason: "they said Thursday, not Friday" }), { verdict: "stopped", why: "they said Thursday, not Friday" });
  assert.deepEqual(mailVerdict({ verdict: "yes", reason: "" }, { held: true }), { verdict: "waiting", why: "Waiting for their yes" });
  assert.equal(mailVerdict({ verdict: "unasked" }, { sent: true }).verdict, "sent");
});

test("an advisor ask is told with the model's own words and what it read", async () => {
  const told = [];
  let now = 0;
  const [{ call }] = advisorTools({
    model: "anthropic/claude-opus-5-5",
    history: [],
    question: "the person's text",
    request: async () => {
      now += 1_200;
      return { text: "Check the calendar first." };
    },
    record: (entry) => told.push(entry),
    clock: () => now,
  });
  const live = {
    system: "",
    tools: [],
    messages: [
      { role: "user", text: "the person's text" },
      { role: "assistant", text: "", toolCalls: [{ name: "read_note", args: {} }] },
      { role: "tool", name: "read_note", text: "..." },
      { role: "assistant", text: "Should I book now or ask them?", toolCalls: [{ name: "ask_advisor", args: {} }] },
    ],
  };
  await call({}, live);
  assert.deepEqual(told, [{ question: "Should I book now or ask them?", answer: "Check the calendar first.", steps: 1, ms: 1_200 }]);
  await call({}, { ...live, messages: live.messages.slice(0, 1) });
  assert.equal(told[1].question, "the person's text", "no words of its own: the person's text");
  const failing = advisorTools({ model: "m", history: [], question: "q", request: async () => { throw new Error("down"); }, record: (entry) => told.push(entry) });
  await failing[0].call({}, live);
  assert.equal(told.length, 2, "an ask that never got an answer is not kept as one");

  const ledger = fakeLedger();
  advisorRecorder({ ledger }, { turn: "turn_0123456789", job: null })(told[0]);
  assert.equal(ledger.entries[0].kind, "advisor");
  assert.equal(ledger.entries[0].question, "Should I book now or ask them?");
  assert.equal(advisorRecorder({ ledger: null }), null, "no ledger, nothing to tell");
});

test("a job's check by the advisor is an ask and a job state in the ledger", async () => {
  const ledger = fakeLedger();
  const job = { id: "job-0123456789", title: "Fill the form" };
  const fields = await jobChecked({ ledger }, { job, steps: 6, turn: "turn_0123456789" }, async () => ({ verdict: "keep_going", advice: "Use the email link.", unfinished: true }));
  assert.equal(fields.verdict, "keep_going", "the fields pass through untouched");
  const [asked, state] = ledger.entries;
  assert.deepEqual([asked.kind, asked.check, asked.question, asked.answer, asked.steps, asked.job], ["advisor", true, 'Is the job "Fill the form" done?', "Not yet: keep going. Use the email link.", 6, "Fill the form"]);
  assert.deepEqual([state.kind, state.job, state.state, state.advice], ["job", "job-0123456789", "keep_going", "Use the email link."]);
  const quiet = fakeLedger();
  await jobChecked({ ledger: quiet }, { job }, async () => ({ unfinished: true }));
  await jobChecked({ ledger: quiet }, { job: null }, async () => ({ verdict: "done" }));
  assert.equal(quiet.entries.length, 0, "no advisor verdict (the phrase check decided), or no job: nothing written");
});

test("a held email settled: sent on a yes, stopped on a no or a failed send", async () => {
  const store = createMemoryStore();
  const ledger = fakeLedger();
  store.ledger = ledger;
  const hold = async () =>
    createPending(store, { name: "send_email", args: { to: ["jo@example.com"], subject: "Re: Thursday", body: "Hi" }, actor: { userId: "u1", clientId: "context_texts" }, texting: true });
  const sent = await hold();
  await settlePending(store, sent.id, { userId: "u1", action: "approve", run: async () => ({ content: [{ type: "text", text: "Sent." }] }) });
  const first = ledger.entries[0];
  assert.deepEqual([first.kind, first.verdict, first.why, first.ref, first.to, first.subject, first.from], ["mail_check", "sent", "They said yes", heldCheckId(sent.id), "jo@example.com", "Re: Thursday", "your texts"]);
  const failed = await hold();
  await settlePending(store, failed.id, { userId: "u1", action: "approve", run: async () => ({ content: [{ type: "text", text: "Gmail refused it." }], isError: true }) });
  assert.equal(ledger.entries[1].verdict, "stopped", "an approved email that could not be sent reads stopped");
  const denied = await hold();
  await settlePending(store, denied.id, { userId: "u1", action: "deny", run: async () => ({}) });
  assert.deepEqual([ledger.entries[2].verdict, ledger.entries[2].why], ["stopped", "They said no"]);
  const other = await createPending(store, { name: "calendar_event", args: {}, actor: { userId: "u1" }, texting: true });
  await settlePending(store, other.id, { userId: "u1", action: "approve", run: async () => ({}) });
  assert.equal(ledger.entries.length, 3, "anything that is not an email leaves the ledger alone");
  await settledMail({}, sent, "approve", {}); // a store with no ledger: nothing, no throw
  recordMail({}, { to: [] }, { verdict: "stopped" }); // a session with no ledger: nothing, no throw
});

test("a texted email's check is read back from the chat's ledger, and its yes names it", async () => {
  const world = await createEgressWorld();
  const { model, env, controlPlane } = world;
  try {
    controlPlane.flags.emailSender = "seyi@gmail.example";
    model.install([
      { toolCalls: [{ name: "send", args: { action: "email", args: { to: ["jo@example.com"], subject: "Re: Thursday", body: "Hi Jo,\n\nThursday at 3 works.\n" } } }] },
      { text: JSON.stringify({ verdict: "yes", reason: "" }) },
      { text: "I drafted a reply to Jo." },
    ]);
    const asked = await ask(env, TOKEN_TEXTS, "reply to Jo that Thursday at 3 works");
    assert.equal(asked.status, 200);
    const ledger = ledgerFor(env, { person: "ws_egress" });
    const held = (await ledger.read("texts", { kinds: ["mail_check"] })).entries;
    assert.equal(held.length, 1, "one check, kept once");
    assert.deepEqual([held[0].verdict, held[0].to, held[0].subject, held[0].from], ["waiting", "jo@example.com", "Re: Thursday", "your texts"]);
    await ask(env, TOKEN_TEXTS, "yes");
    const after = (await ledger.read("texts", { kinds: ["mail_check"] })).entries;
    assert.equal(after.length, 2, "the yes is a new entry, the first is never rewritten");
    assert.deepEqual([after[1].verdict, after[1].ref], ["sent", held[0].id]);
  } finally {
    await world.close?.();
  }
});
