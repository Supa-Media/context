/**
 * Sent mail in the bench (2026-11-18, Training): a draft Tex quoted in the chat was taken by the simulated world as
 * sent, so when the person said "send it" Tex searched Sent, found the invented copy and did not send. Two rules
 * fix it: a quoted draft is still a draft, and Sent holds only what the chat says was sent or what the bench's own
 * mailbox really sent during the run. The bench's Gmail answers `in:sent` from those sends and from nothing else.
 *
 * Sabotage: dropping the draft rule from `simSystem`, leaving the real sends out of the world's system text, or
 * reverting `in:sent` to match every fixture email fails these.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSimWorld, simMemo, simSystem, simulateServices } from "../simWorld.mjs";
import { readMailbox, searchMailbox, sentMail } from "../mailbox.mjs";
import { createEmailRoute } from "../../test/controlPlaneStub/email.mjs";
import { frontFor } from "../setsFd.mjs";
import { parseTest } from "../load.mjs";

const BENCH = new URL("../ai", import.meta.url).pathname;

/** A model that answers each call kind with `answers[kind]`, keeping what it was asked. */
function scriptedSend(answers) {
  const asked = [];
  const send = async (body) => {
    const request = JSON.parse(body);
    asked.push(request);
    const kind = /^Call: (.+)$/m.exec(request.messages[0].content)[1];
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(answers[kind] ?? {}) }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  };
  return { send, asked };
}

const INBOX = "john@gmail.example";
const inboxMail = [
  { address: INBOX, id: "i1", threadId: "i1", date: "2026-11-10T09:00:00.000Z", from: "Priya <priya@example.invalid>", to: INBOX, subject: "Flat rent", body: "Rent is due Friday.", attachments: [], snippet: "Rent is due Friday." },
];

test("a draft the chat quotes is still a draft: the world is told it is in no folder unless the chat says it was sent", () => {
  const system = simSystem({ setting: "Tex has Gmail", chat: [{ who: "Tex", text: "Draft: 'Dinner Friday?'" }], sent: [] });
  assert.match(system, /A draft the chat quotes is still a draft/);
  assert.match(system, /not in Sent/);
  assert.match(system, /unless the chat says it was sent/);
});

test("Sent holds the real sends, listed to the world, and nothing the world would otherwise invent", () => {
  const system = simSystem({ setting: "s", chat: [], sent: [{ to: "priya@example.invalid", subject: "Dinner Friday" }] });
  assert.match(system, /Sent folder[^]*priya@example\.invalid[^]*Dinner Friday/);
  assert.match(simSystem({ setting: "s", chat: [], sent: [] }), /Sent folder holds no mail/);
});

test("the world's model is asked about Sent with the sends made at the time of the ask", async () => {
  const { send, asked } = scriptedSend({ "gmail search": { results: [] } });
  let sent = [];
  const sim = createSimWorld({ send, setting: "Tex has Gmail", memo: simMemo(), sent: () => sent });
  sent = [{ to: "priya@example.invalid", subject: "Dinner Friday" }];
  await sim.mailSearch("in:sent dinner");
  assert.match(asked[0].system, /Dinner Friday/, "a send made during the run is in the world's Sent");
});

test("a fixture email is in the inbox, never in Sent: `in:sent` finds none of them", () => {
  assert.deepEqual(searchMailbox(inboxMail, "in:sent").map((row) => row.id), []);
  assert.deepEqual(searchMailbox(inboxMail, "in:inbox").map((row) => row.id), ["i1"]);
  assert.deepEqual(searchMailbox(inboxMail, "-in:sent").map((row) => row.id), ["i1"]);
});

test("sentMail keeps only the sends the bench really made: not drafts, checks or refusals", () => {
  const calls = [
    { email: { to: ["priya@example.invalid"], subject: "Dinner Friday", body: "Friday 7?", from: INBOX }, check: false, draft: false, answer: { ok: true, from: INBOX } },
    { email: { to: ["priya@example.invalid"], subject: "Draft only", body: "x" }, check: false, draft: true, answer: { ok: true, from: INBOX } },
    { email: { to: ["priya@example.invalid"], subject: "Checked", body: "x" }, check: true, draft: false, answer: { ok: true, from: INBOX } },
    { email: { to: ["priya@example.invalid"], subject: "Refused", body: "x" }, check: false, draft: false, answer: { ok: false, refused: "no_sender" } },
  ];
  const rows = sentMail(calls, INBOX);
  assert.deepEqual(rows.map((row) => row.subject), ["Dinner Friday"]);
  assert.equal(rows[0].to, "priya@example.invalid");
  assert.equal(rows[0].address, INBOX);
});

test("a Sent search finds the real send and every other search finds it too, and it reads back in full", () => {
  const rows = sentMail([{ email: { to: ["priya@example.invalid"], subject: "Dinner Friday", body: "Friday 7?" }, check: false, draft: false, answer: { ok: true, from: INBOX } }], INBOX);
  const mail = [...inboxMail, ...rows];
  assert.deepEqual(searchMailbox(mail, "in:sent").map((row) => row.subject), ["Dinner Friday"]);
  assert.deepEqual(searchMailbox(mail, "-in:sent").map((row) => row.subject), ["Flat rent"]);
  assert.deepEqual(searchMailbox(mail, "dinner").map((row) => row.subject), ["Dinner Friday"]);
  assert.match(readMailbox(mail, INBOX, rows[0].id).body, /Friday 7\?/);
});

test("the sends the bench made answer a Gmail search even when the person has no fixture mail", async () => {
  const { send, asked } = scriptedSend({ "gmail search": { results: [] } });
  const sim = createSimWorld({ send, setting: "Tex has Gmail", person: "John", memo: simMemo(), sent: (address) => sentMail([{ email: { to: ["priya@example.invalid"], subject: "Dinner Friday", body: "Friday 7?" }, check: false, draft: false, answer: { ok: true, from: address } }], address) });
  const flags = {};
  simulateServices(sim, { flags }, { connectMail: true });
  const found = await flags.mailResults("in:sent");
  assert.deepEqual(found.map((row) => row.subject), ["Dinner Friday"], "the real send is Sent, and the world invents nothing beside it");
  assert.match(asked[0].system, /Dinner Friday/, "the world knows what was sent");
});

/**
 * Sending is opt-in in the bench (2026-11-18). A Gmail connect asks for `gmail.send` (`googleOAuth.ts` WRITE_SCOPES),
 * but the core tasks were written while send was refused and expect that, so only a test that says `gmail: sends`
 * (every Training and Dev set conversation does, `frontFor`) connects a mailbox that may send. Without it a send is
 * refused with no_sender, as before. Sabotage: `connectMailbox` setting `emailSender` unconditionally, or `frontFor`
 * dropping the line, fails these.
 */

test("without `gmail: sends` the connected mailbox refuses a send: no_sender, and nothing in Sent", async () => {
  const flags = {};
  const route = createEmailRoute(async () => true, flags);
  const sim = createSimWorld({ send: null, setting: "Tex has Gmail", person: "John", memo: simMemo(), sent: (address) => sentMail(route.calls, address) });
  simulateServices(sim, { flags }, { connectMail: true });
  assert.equal(flags.emailSender ?? null, null, "a core test's mailbox has no sender (the stub's default is null)");
  const answer = await route.handle("/gateway/email/send", { accessToken: "bench-token", email: { from: sim.address, to: ["priya@example.invalid"], subject: "Dinner Friday", body: "Friday 7?" } });
  assert.deepEqual(answer, { ok: false, refused: "no_sender" });
  assert.deepEqual((await flags.mailResults("in:sent")).map((row) => row.subject), []);
});

test("with `gmail: sends` the connected mailbox sends: the route accepts it, and the send is in Sent", async () => {
  const flags = {};
  const route = createEmailRoute(async () => true, flags);
  const sim = createSimWorld({ send: null, setting: "Tex has Gmail", person: "John", memo: simMemo(), sent: (address) => sentMail(route.calls, address) });
  simulateServices(sim, { flags }, { connectMail: true, sends: true });
  assert.equal(flags.emailSender, sim.address, "the connected mailbox is the one that sends");
  const answer = await route.handle("/gateway/email/send", {
    accessToken: "bench-token",
    email: { from: sim.address, to: ["priya@example.invalid"], subject: "Dinner Friday", body: "Friday 7?" },
  });
  assert.deepEqual(answer, { ok: true, from: sim.address }, "the route sends rather than answering no_sender");
  assert.deepEqual((await flags.mailResults("in:sent")).map((row) => row.subject), ["Dinner Friday"], "the send is in Sent");
});

test("frontFor gives every set conversation `gmail: sends`, and parseTest reads it", async () => {
  const front = await frontFor(BENCH, "John", { today: "2026-10-13", setting: "Tex has Gmail." });
  assert.match(front, /^gmail: sends$/m);
  assert.equal(parseTest(`---\n${front}\n---\n\n# T\n\n## 1. hi\n\n- person texts: "hi"\n`).front.gmail, "sends");
});
