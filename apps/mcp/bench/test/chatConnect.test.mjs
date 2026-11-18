/**
 * Google Chat in the bench (2026-11-18, Training): a chat whose setting says Tex has Google Chat answered "I can't
 * read Chat yet", because nothing in the bench connected the control plane's Google Chat stub. A setting that names
 * Chat connects it (`hasChat`, `frontFor`, `connectChat`), as one that names Calendar connects the calendar, and the
 * simulated world answers the Chat read the way it answers other services.
 *
 * Sabotage: `connectChat` leaving `from` unset, the recent read answered from nothing, or `hasChat` matching every
 * setting fails these.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSimWorld, simMemo } from "../simWorld.mjs";
import { connectChat } from "../chat.mjs";
import { frontFor, hasChat } from "../setsFd.mjs";
import { parseTest } from "../load.mjs";
import { createGoogleChatRoute } from "../../test/controlPlaneStub/googleChat.mjs";

const BENCH = new URL("../ai", import.meta.url).pathname;

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

const allowed = async () => true;

test("a setting that names Google Chat connects Chat, and one that does not leaves it alone", async () => {
  assert.equal(hasChat({ setting: "Tex has John's Gmail, Calendar, Google Chat, Context notes (@john)." }), true);
  assert.equal(hasChat({ setting: "Tex has Gmail, Calendar and the web." }), false);
  assert.equal(hasChat({}), false);
  const front = await frontFor(BENCH, "John", { today: "2026-10-13", chat: true, setting: "Tex has Google Chat." });
  assert.match(front, /^chat: connected$/m);
  const plain = await frontFor(BENCH, "John", { today: "2026-10-13", setting: "Tex has Gmail." });
  assert.doesNotMatch(plain, /^chat: /m, "a setting without Chat connects nothing");
  assert.equal(parseTest(`---\n${front}\n---\n\n# T\n\n## 1. hi\n\n- person texts: "hi"\n`).front.chat, "connected");
});

test("a connected Chat is the person's account, and the route answers spaces and no refusal", async () => {
  const route = createGoogleChatRoute(allowed);
  const sim = createSimWorld({ send: null, setting: "Tex has Google Chat", person: "John", memo: simMemo() });
  connectChat(route, { person: "John", sim });
  assert.equal(route.flags.from, sim.address, "the account is the person's own, as the world's Gmail is");
  const listed = await route.handle("/gateway/chat/spaces", { accessToken: "t", account: sim.address });
  assert.equal(listed.ok, true, "Chat is connected, so the read is not refused as no chat");
  assert.deepEqual(listed.accounts, [sim.address]);
});

test("the Chat read is the simulated world's, asked the way other services are, and it reads back the messages it says", async () => {
  const { send, asked } = scriptedSend({
    "google chat recent": { messages: [{ from: "Ada Example", text: "we may have to call off the showcase", at: "2026-11-15T17:00:00.000Z" }] },
  });
  const sim = createSimWorld({ send, setting: "Tex has Google Chat", person: "John", memo: simMemo() });
  const route = createGoogleChatRoute(allowed);
  connectChat(route, { person: "John", sim });
  const read = await route.handle("/gateway/chat/recent", { accessToken: "t", to: "ada@example.invalid", account: sim.address });
  assert.equal(read.ok, true);
  assert.equal(read.messages[0].from, "Ada Example");
  assert.match(read.messages[0].text, /call off the showcase/);
  assert.equal(asked.length, 1, "asked once, as any other service");
  assert.match(asked[0].messages[0].content, /"to":"ada@example\.invalid"/, "the request names the conversation");
  assert.doesNotMatch(asked[0].messages[0].content, /accessToken/, "the bench's token never reaches the world");
});

test("a Chat with no simulated world is connected and reads nothing, rather than refusing", async () => {
  const route = createGoogleChatRoute(allowed);
  connectChat(route, { person: "John", sim: null });
  assert.match(route.flags.from, /^john@chat\.bench\.invalid$/);
  const read = await route.handle("/gateway/chat/recent", { accessToken: "t", to: "ada@example.invalid", account: route.flags.from });
  assert.deepEqual(read.messages, []);
});
