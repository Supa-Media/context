/**
 * A LONG PASTED TEXT REACHES THE MODEL WHOLE, THROUGH THE REAL `/agent` ROUTE WITH `covers` (2026-11-11).
 *
 * In a 1:1 iMessage Dev2 pasted a brief written for another AI, its instructions first and the brief after. The log
 * kept 3,000 characters of it and the model was asked those, so Tex said the brief was missing.
 *
 * Every turn here reads the chat's log (`loggedTurn.js`): the earlier text puts the log's preface in the history,
 * and a group's question names its speaker. Sabotage these and a test here fails:
 *  1. `log.js` `MAX_EVENT_TEXT` back to 3_000: the brief's event is refused, the turn is not a logged one → every test.
 *  2. `loggedTurn.js` asking the log's words over the Worker's (`whole` returns `kept`) → "a text the log kept cut".
 *  3. `loggedTurn.js` `whole` back to a bare prefix match (any shorter text that starts the question) → "never put under another".
 *  4. `whole` taking the mark in the words without `left` → "a typed mark".
 *  5. `oneSender` dropped from the group's question → "two people's texts".
 *  6. the `OLD_CAP_UNTIL` check dropped → "after the cutoff".
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, TEXTED_CHAT, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { LOG_PREFACE, loggedTurn, OLD_CAP_UNTIL } from "../src/agent/loggedTurn.js";
import { checkEvent } from "../src/agent/log.js";

const TOKEN_GROUP = `cat_fulltext_group_ada_${"0".repeat(16)}`;
const KEY = "f".repeat(64);
const MEMBERS = "e".repeat(64);
const ADA = "a".repeat(64);
const LAST = "Last line of the brief: ship the screens by Friday.";
/** About 6,000 characters: instructions for another AI first, the brief's content after, its last line at the end. */
const BRIEF = `${"Instructions for the screens: read the brief below and draw each screen it names.\n".repeat(40)}\nThe brief:\n${"The home screen lists every chat, newest first.\n".repeat(55)}${LAST}`;

let world;
before(async () => {
  world = await createEgressWorld();
  await world.controlPlane.addGrant({ accessToken: TOKEN_GROUP, workspaceId: "ws_egress_team", role: "editor", scopes: ["context:read", "context:write"], clientId: "context_texts_group", clientName: "Tex (group chats)", userId: "user_egress", texChatId: KEY });
  world.controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
});
after(() => world.restore());

let n = 0;
/** An earlier text, then `logged` as the Worker logged it and `question` as it asked: what the model was sent. */
async function texted(token, question, { logged = question, left = undefined, group = null } = {}) {
  n += 1;
  const at = Date.now();
  const chat = group ?? TEXTED_CHAT;
  const conversation = group ? { group } : "texts";
  const from = { kind: "person", ...(group ? { who: ADA, name: "Ada" } : {}) };
  const earlier = { id: `${at - 1000}-${String(n * 2).padStart(6, "0")}`, at: at - 1000, chat, from, kind: "text", text: "I will paste the brief next." };
  const theirs = { id: `${at}-${String(n * 2 + 1).padStart(6, "0")}`, at, chat, from, kind: "text", text: logged, ...(left ? { left } : {}) };
  for (const event of [earlier, theirs]) await request(world.env, token, "/agent/events", { conversation, events: [event] });
  world.model.install([{ text: "Got the brief." }]);
  const body = group ? { question, group: { key: group, members: MEMBERS, from: "ada" }, timeZone: "UTC" } : { question, conversation };
  const answered = await request(world.env, token, "/agent", { ...body, covers: [theirs.id], chat, turn: `turn-fulltext-${String(n).padStart(4, "0")}` });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const messages = world.model.requests.at(-1).messages;
  const text = (message) => (typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"));
  return { all: messages.map(text).join("\n"), asked: text(messages.at(-1)) };
}

test("1:1: a 6,000-character pasted brief reaches the model's question with its last line", async () => {
  assert.ok(BRIEF.length > 5_500 && BRIEF.length < 6_500);
  const { all, asked } = await texted(TOKEN_TEXTS, BRIEF);
  assert.ok(all.includes(LOG_PREFACE), "a logged turn");
  assert.ok(asked.trimEnd().endsWith(LAST), "the brief's last line is the end of the question");
});

test("a group: a 6,000-character pasted brief reaches the model's question with its last line", async () => {
  const { all, asked } = await texted(TOKEN_GROUP, BRIEF, { group: KEY });
  assert.ok(all.includes(LOG_PREFACE), "a logged turn");
  assert.match(asked, /Ada: Instructions for the screens/, "the log's question, its speaker named");
  assert.ok(asked.trimEnd().endsWith(LAST), "the brief's last line is the end of the question");
});

test("a text the log kept cut reaches the model whole, as the Worker sent it", async () => {
  // An event a Worker logged at its old 3,000, with no mark, and one a cap cut with its mark.
  // One a Worker logged at its old 3,000, and one a Worker cut, with its mark and its `left`.
  for (const cut of [{ logged: BRIEF.slice(0, 3_000) }, { logged: `${BRIEF.slice(0, 3_000)}\n[cut: ${BRIEF.length - 3_000} more characters]`, left: BRIEF.length - 3_000 }]) {
    const { all, asked } = await texted(TOKEN_TEXTS, BRIEF, cut);
    assert.ok(all.includes(LOG_PREFACE), "a logged turn");
    assert.ok(asked.trimEnd().endsWith(LAST), "the brief's last line is the end of the question");
    assert.ok(!asked.includes("[cut:"), "no mark once whole");
  }
  const { asked } = await texted(TOKEN_GROUP, BRIEF, { logged: BRIEF.slice(0, 3_000), group: KEY });
  assert.ok(asked.trimEnd().endsWith(LAST), "a group's too");
});

test("a group: one member's long text is never put under another member's name", async () => {
  // Ada's brief logged cut, then Bo's short text last; the Worker's question is Ada's whole brief.
  n += 1;
  const at = Date.now();
  const id = (k) => `${at + k}-${String(900 + n * 3 + k).padStart(6, "0")}`;
  const ada = { id: id(0), at, chat: KEY, from: { kind: "person", who: ADA, name: "Ada" }, kind: "text", text: BRIEF.slice(0, 3_000) };
  const bo = { id: id(1), at: at + 1, chat: KEY, from: { kind: "person", who: "b".repeat(64), name: "Bo" }, kind: "text", text: "Instructions for the screens:" }; // short, and the start of Ada's words
  await request(world.env, TOKEN_GROUP, "/agent/events", { conversation: { group: KEY }, events: [ada, bo] });
  world.model.install([{ text: "Noted." }]);
  const answered = await request(world.env, TOKEN_GROUP, "/agent", { question: BRIEF, group: { key: KEY, members: MEMBERS, from: "ada" }, timeZone: "UTC", covers: [ada.id, bo.id], chat: KEY, turn: `turn-fulltext-mix-${n}` });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const last = world.model.requests.at(-1).messages.at(-1);
  const asked = typeof last.content === "string" ? last.content : last.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.match(asked, /^@Bo: Instructions for the screens:$/m, "Bo's line is Bo's words alone");
  assert.doesNotMatch(asked, /^@Bo: .*The brief:/m, "Ada's words never appear under Bo");
  assert.ok(!asked.includes(LAST), "nothing restored onto a text that was not cut");
});

/* ---------------- the restore's proof, on the turn's read alone ---------------- */

/** The question `loggedTurn` asks for `covered`, events read as the Worker's outbox holds them. */
async function askedFor(covered, question, group = null) {
  const logged = await loggedTurn(null, { chat: KEY, covers: covered.map((event) => event.id), question }, { group, warm: { events: async () => covered } });
  return logged.question;
}
let u = 0;
const unitEvent = (fields) => ({ id: `${fields.at}-${String(++u).padStart(6, "0")}`, chat: KEY, kind: "text", from: { kind: "person", who: ADA, name: "Ada" }, ...fields });
const MARKED = `${BRIEF.slice(0, 3_000)}\n[cut: ${BRIEF.length - 3_000} more characters]`;
const AFTER = OLD_CAP_UNTIL + 60_000;

test("a typed mark restores nothing: only the Worker's `left` does", async () => {
  const typed = unitEvent({ at: AFTER, text: MARKED });
  assert.ok(!(await askedFor([typed], BRIEF)).includes(LAST), "a person typing the mark gets nothing back");
  const cut = unitEvent({ at: AFTER, text: MARKED, left: BRIEF.length - 3_000 });
  assert.ok((await askedFor([cut], BRIEF)).endsWith(LAST), "the Worker's cut is restored");
  const wrong = unitEvent({ at: AFTER, text: MARKED, left: BRIEF.length - 2_999 });
  assert.ok(!(await askedFor([wrong], BRIEF)).includes(LAST), "a count that does not match restores nothing");
});

test("a group: two people's texts restore nothing, one person's do", async () => {
  const group = { members: MEMBERS };
  const ada = unitEvent({ at: AFTER, text: "see below" });
  const bo = unitEvent({ at: AFTER + 1, text: MARKED, left: BRIEF.length - 3_000, from: { kind: "person", who: "b".repeat(64), name: "Bo" } });
  assert.ok(!(await askedFor([ada, bo], BRIEF, group)).includes(LAST), "Ada's question never fills Bo's text");
  const adaToo = unitEvent({ at: AFTER + 2, text: MARKED, left: BRIEF.length - 3_000 });
  assert.ok((await askedFor([ada, adaToo], BRIEF, group)).endsWith(LAST), "one person's texts are restored");
});

test("the old 3,000 counts only before the cutoff", async () => {
  assert.ok((await askedFor([unitEvent({ at: OLD_CAP_UNTIL - 60_000, text: BRIEF.slice(0, 3_000) })], BRIEF)).endsWith(LAST), "before the cutoff");
  assert.ok(!(await askedFor([unitEvent({ at: AFTER, text: BRIEF.slice(0, 3_000) })], BRIEF)).includes(LAST), "after the cutoff");
});

test("`left` is taken only as a whole count on a person's text", () => {
  const now = Date.now();
  const check = (fields) => { try { checkEvent({ id: `${now}-000001`, at: now, chat: KEY, from: { kind: "person" }, kind: "text", text: "x", ...fields }, { chat: KEY, now }); return null; } catch (error) { return error.field; } };
  assert.equal(check({ left: 5 }), null);
  for (const left of [0, -1, 1.5, "5"]) assert.equal(check({ left }), "left");
  assert.equal(check({ left: 5, from: { kind: "tex" } }), "left");
  assert.equal(check({ left: 5, kind: "link" }), "left");
});
