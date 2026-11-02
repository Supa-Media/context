/**
 * HOW TEX TALKS, AS THE CHAT SET IT (`src/agent/texStyle.js`, Dev2, 2026-10-28).
 *
 * The Worker sends the chat's style with a texted turn; the gateway reads it
 * at the trust boundary (closed sets, humor a whole ten from 0 to 100) and
 * says it after the rest of the system prompt. A style with any part off its
 * set is dropped whole, and the turn still runs.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `readTexStyle` accepting any humor number: "a style off its set is dropped whole" fails;
 *  - the route not appending `stylePrompt`: "a group turn is told the group's style" fails.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { readTexStyle, stylePrompt } from "../src/agent/texStyle.js";

test("each setting says one line, and every default says nothing", () => {
  assert.equal(stylePrompt(readTexStyle({})), "");
  assert.equal(stylePrompt(readTexStyle({ tone: "default", warmth: "default", bubbles: "multiple" })), "");
  const said = stylePrompt(readTexStyle({ tone: "efficient", warmth: "less", enthusiasm: "more", emoji: "less", length: "short", bubbles: "one", humor: 60 }));
  for (const line of [/Tone: efficient\. .*no closing line, no emoji/, /Warmth: less/, /Enthusiasm: more/, /Emoji: less\. Use no emoji/, /Length: short/, /Bubbles: one/, /Humor: 60%\. an occasional light joke/]) {
    assert.match(said, line);
  }
  assert.match(stylePrompt(readTexStyle({ humor: 0 })), /Humor: 0%\. no jokes or wordplay at all/);
  for (const tone of ["professional", "friendly", "candid", "quirky", "nerdy", "cynical"]) assert.match(stylePrompt(readTexStyle({ tone })), new RegExp(`Tone: ${tone}\\.`));
});

test("a style off its set is dropped whole", () => {
  for (const bad of [{ humor: 65 }, { humor: 120 }, { humor: "60" }, { tone: "sarcastic" }, { emoji: "none" }, { mood: "happy" }, [], "efficient", null, undefined]) {
    assert.equal(readTexStyle(bad), null, JSON.stringify(bad));
  }
  assert.equal(readTexStyle({ tone: "candid", humor: 65 }), null, "never trimmed into something nobody asked for");
});

const TOKEN_CHAT = `cat_group_style_chat_${"0".repeat(20)}`;
const KEY = "e".repeat(64);
const MEMBERS = "f".repeat(64);
let world;

before(async () => {
  world = await createEgressWorld();
  await world.controlPlane.addGrant({
    accessToken: TOKEN_CHAT,
    workspaceId: "ws_egress_team",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    clientName: "Tex (group chats)",
    userId: "user_egress",
  });
  world.controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
});
after(() => world.restore());

const tagged = (texStyle) =>
  request(world.env, TOKEN_CHAT, "/agent", { question: "Tex what's up?", group: { key: KEY, members: MEMBERS, from: "ada", people: ["ada"] }, timeZone: "UTC", ...(texStyle === undefined ? {} : { texStyle }) });

test("a group turn is told the group's style, after the rest of the prompt", async () => {
  world.model.install([{ text: "Not much." }]);
  const asked = await tagged({ tone: "cynical", humor: 60 });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const system = JSON.stringify(world.model.requests.at(-1).system);
  assert.match(system, /How they asked you to talk in this chat/);
  assert.match(system, /Tone: cynical\./);
  assert.match(system, /Humor: 60%/);
  assert.ok(system.indexOf("How they asked you to talk") > system.indexOf("This turn is a text message"), "said after the texting prompt");
});

test("a malformed style is ignored and the turn still runs", async () => {
  world.model.install([{ text: "Not much." }]);
  const asked = await tagged({ tone: "cynical", humor: 65 });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.doesNotMatch(JSON.stringify(world.model.requests.at(-1).system), /How they asked you to talk|Tone: cynical/);
});
