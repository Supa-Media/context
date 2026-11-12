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
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, TEXTED_CHAT, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { LOG_PREFACE } from "../src/agent/loggedTurn.js";

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
async function texted(token, question, { logged = question, group = null } = {}) {
  n += 1;
  const at = Date.now();
  const chat = group ?? TEXTED_CHAT;
  const conversation = group ? { group } : "texts";
  const from = { kind: "person", ...(group ? { who: ADA, name: "Ada" } : {}) };
  const earlier = { id: `${at - 1000}-${String(n * 2).padStart(6, "0")}`, at: at - 1000, chat, from, kind: "text", text: "I will paste the brief next." };
  const theirs = { id: `${at}-${String(n * 2 + 1).padStart(6, "0")}`, at, chat, from, kind: "text", text: logged };
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
  for (const logged of [BRIEF.slice(0, 3_000), `${BRIEF.slice(0, 3_000)}\n[cut: ${BRIEF.length - 3_000} more characters]`]) {
    const { all, asked } = await texted(TOKEN_TEXTS, BRIEF, { logged });
    assert.ok(all.includes(LOG_PREFACE), "a logged turn");
    assert.ok(asked.trimEnd().endsWith(LAST), "the brief's last line is the end of the question");
    assert.ok(!asked.includes("[cut:"), "no mark once whole");
  }
  const { asked } = await texted(TOKEN_GROUP, BRIEF, { logged: BRIEF.slice(0, 3_000), group: KEY });
  assert.ok(asked.trimEnd().endsWith(LAST), "a group's too");
});
