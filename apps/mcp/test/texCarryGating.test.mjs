/**
 * What the stretch carries in production (owner-approved fix, Dev2, 2026-11-10): #3156 replayed nothing, because every
 * group reply is `clean: false` (its chat's own words) and was stubbed as outside, and every 1:1 text runs under a new
 * fifteen-minute token whose grant id never matched the last text's. Through the real `/agent` route with `covers`.
 *
 * Sabotage these and a test here fails:
 *  1. `stretch.js` stubbing on `turn.tainted` again → "a group: the same asker's second text".
 *  2. `stretch.js` `carryKey` answering `session.grantId` for the Texts client → "1:1: two texts under two tokens".
 *  3. `readTheHistory.js` not marking the turn on `carry.outside` → "a web lookup is carried".
 *  4. `sendTheReply.js` not recording `outside` (legacy `clean` then decides, so a group reply reads as outside) →
 *     "a group: the same asker's second text" (its line says `carriedOutside: yes`).
 *  5. `stretch.js` replaying another member's reads (`other` forced false) → "another member's private read".
 *  6. `readTheHistory.js` dropping the `tex_carry` line → every test reading `lines()`.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, TEXTED_CHAT, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { STUB_GRANT, STUB_OTHER, carryKey } from "../src/agent/stretch.js";
import { withAgentHome } from "./texStoreFixture.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const TOKEN_TEXTS_NEXT = `cat_carry_texts_next_${"0".repeat(18)}`;
const TOKEN_GROUP_ADA = `cat_carry_group_ada_${"0".repeat(19)}`;
const TOKEN_GROUP_BO = `cat_carry_group_bo_${"0".repeat(20)}`;
const KEY = "d".repeat(64);
const MEMBERS = "e".repeat(64);
const ADA = "a".repeat(64);
const BO = "b".repeat(64);

let world;
const logged = [];
const realLog = console.log;
before(async () => {
  world = await createEgressWorld();
  const { controlPlane } = world;
  // The next text's token: the same person, workspace and scopes, a new grant id, as `personTexting.js` mints one each text.
  await controlPlane.addGrant({ accessToken: TOKEN_TEXTS_NEXT, workspaceId: "ws_egress", role: "owner", scopes: ["context:read", "context:write", "context:private"], clientId: "context_texts", clientName: "Context (texts)", userId: "user_egress", alsoMemberOf: [{ workspaceId: "ws_egress_team", role: "editor" }] });
  const group = (accessToken, userId) => controlPlane.addGrant({ accessToken, workspaceId: "ws_egress_team", role: "editor", scopes: ["context:read", "context:write"], clientId: "context_texts_group", clientName: "Tex (group chats)", userId, texChatId: KEY });
  await group(TOKEN_GROUP_ADA, "user_egress");
  await group(TOKEN_GROUP_BO, "user_member");
  controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
  world.team.set("notes/setlist.md", { body: "# Setlist\n\nOpener: Blue Train.\n", etag: "s1" });
  console.log = (...args) => {
    if (typeof args[0] === "string" && args[0].includes('"event":"tex_carry"')) logged.push(JSON.parse(args[0]));
    realLog(...args);
  };
});
after(() => {
  console.log = realLog;
  world.restore();
});

const blocks = (sent) => (sent?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []));
const results = (sent) => blocks(sent).filter((block) => block.type === "tool_result").map((block) => String(block.content));
let n = 0;

/** A text and its answer as the texting Worker makes them, in a person's chat or a group's. */
async function texted(token, question, { group = null, who = null } = {}) {
  n += 1;
  const at = Date.now();
  const id = (offset) => `${at + offset}-${String(n * 2 + offset).padStart(6, "0")}`;
  const chat = group ?? TEXTED_CHAT;
  const conversation = group ? { group } : "texts";
  const theirs = { id: id(0), at, chat, from: { kind: "person", ...(who ? { who } : {}) }, kind: "text", text: question };
  const turn = `turn-carry-${String(n).padStart(4, "0")}`;
  await request(world.env, token, "/agent/events", { conversation, events: [theirs] });
  const body = group ? { question, group: { key: group, members: MEMBERS, from: who === ADA ? "ada" : "bo" }, timeZone: "UTC" } : { question, conversation };
  const answered = await request(world.env, token, "/agent", { ...body, covers: [theirs.id], chat, turn });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const said = typeof answered.body?.answer === "string" ? answered.body.answer : "";
  if (said !== "") await request(world.env, token, "/agent/events", { conversation, events: [{ id: id(1), at: at + 1, chat, from: { kind: "tex" }, kind: "text", text: said, turn, covers: [theirs.id], delivered: true }] });
  return { sent: world.model.requests.at(-1), line: logged.at(-1), turn };
}

test("carryKey: the Texts client keys on person, workspace and scopes; any other keeps its grant id", () => {
  const texts = { actorClientId: "context_texts", actorUserId: "u", workspaceId: "w", scopes: ["context:write", "context:read"], grantId: "grant_9" };
  assert.equal(carryKey(texts), "u:w:context:read,context:write");
  assert.equal(carryKey({ ...texts, grantId: "grant_10" }), carryKey(texts), "a new token is the same key");
  assert.notEqual(carryKey({ ...texts, scopes: ["context:read"] }), carryKey(texts), "narrowed scopes are another key");
  assert.equal(carryKey({ ...texts, actorClientId: "context_texts_group" }), "grant_9");
  assert.equal(carryKey(null), null);
});

test("1:1: two texts under two tokens carry the first's result", async () => {
  world.bucket.set("1-projects/venue.md", { body: "# Venue\n\nThe hall on Elm St.\n", etag: "v1" });
  world.model.install([{ toolCalls: [{ name: "read_note", args: { path: "1-projects/venue.md" } }] }, { text: "The hall on Elm St." }]);
  await texted(TOKEN_TEXTS, "where is the venue?");
  world.model.install([{ text: "Doors at 6." }]);
  const { sent, line } = await texted(TOKEN_TEXTS_NEXT, "and doors?");
  const carried = results(sent);
  assert.equal(carried.length, 1);
  assert.match(carried[0], /Elm St/, "carried under a new token");
  assert.ok(!carried.includes(STUB_GRANT));
  const { event: _event, ...counts } = line;
  assert.deepEqual(counts, { carried: 1, stubOther: 0, stubGrant: 0, stubWorkspace: 0, carriedOutside: "no", stretch: 2 });
});

test("a web lookup is carried, and the next turn is untrusted as if it had read the page", async () => {
  world.model.install([{ toolCalls: [{ name: "open_page", args: { url: "https://example.com/status" } }] }, { text: "All fine." }]);
  const first = await texted(TOKEN_TEXTS_NEXT, "check https://example.com/status");
  world.model.install([{ text: "Yes, all fine." }]);
  const { sent, line, turn } = await texted(TOKEN_TEXTS, "still fine?");
  assert.ok(results(sent).some((result) => /All fine\. Now make/.test(result)), "the page's words are replayed");
  assert.equal(line.carriedOutside, "yes");
  const replies = withAgentHome(world.bucket, world.tex, "ws_egress").ledgerEntries().filter((entry) => entry.kind === "reply");
  const ofTurn = (id) => replies.find((entry) => entry.turn === id);
  assert.equal(ofTurn(first.turn).outside, true, "the page read is recorded on its reply");
  assert.equal(ofTurn(turn).clean, false, "the turn that replayed it is untrusted: its sends and reflect go as an untrusted turn's");
  assert.equal(ofTurn(turn).outside, true, "and outside, so the next text of the stretch is marked too");
});

test("a group: the same asker's second text carries; another member's private read is stubbed", async () => {
  world.model.install([{ toolCalls: [{ name: "read_note", args: { path: "notes/setlist.md" } }] }, { text: "Blue Train opens." }]);
  await texted(TOKEN_GROUP_ADA, "@tex what's the opener?", { group: KEY, who: ADA });
  world.model.install([{ text: "Then Naima." }]);
  const same = await texted(TOKEN_GROUP_ADA, "@tex and after it?", { group: KEY, who: ADA });
  assert.ok(results(same.sent).some((result) => /Blue Train/.test(result)), "the same asker's result is replayed, not stubbed as outside");
  assert.equal(same.line.carried, 1);
  assert.equal(same.line.carriedOutside, "no", "a group's own words are not outside");
  world.model.install([{ text: "Ask Ada." }]);
  const other = await texted(TOKEN_GROUP_BO, "@tex what did you read for Ada?", { group: KEY, who: BO });
  assert.ok(results(other.sent).every((result) => result === STUB_OTHER), "another member's read is stubbed");
  assert.equal(other.line.stubOther, 1);
  assert.equal(other.line.carried, 0);
});
