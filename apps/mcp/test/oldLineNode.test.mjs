/**
 * Node "oldLine" (Tex's old number, the Photon switch): the reply, when it goes, and when a text is held or passes on;
 * and `/texts/old-line`, which runs it on the gateway's graph with its input checked against the config's inSchema.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OLD_LINE_EVERY_MS, oldLineNode } from "../../../packages/tex/gateway/agent/graph/nodes/oldLine.js";
import { oldLineForTexts } from "../../../packages/tex/gateway/agent/textsOldLine.js";

const OLD_CHAT = "sendblue:+15555550199:+15555550100";
const NUMBER = "+15555550142";
const TEXT = "I've moved to +1 (555) 555-0142. Text me there instead, same Tex, same notes.";
const redirect = { chatId: OLD_CHAT, mode: "redirect", number: NUMBER, now: 1_000 };

test("a text on the old Sendblue line, in redirect mode, gets the new number", async () => {
  assert.deepEqual(await oldLineNode(redirect), { to: "redirect", answer: TEXT });
  assert.deepEqual(await oldLineNode({ ...redirect, archiveOn: "2026-12-01" }), { to: "redirect", answer: `${TEXT} This number stops working on December 1.` });
});

test("every other text passes on to Triage: mode off, no number, or a chat on another line", async () => {
  assert.deepEqual(await oldLineNode({ ...redirect, mode: "off" }), { to: "pass" });
  assert.deepEqual(await oldLineNode({ chatId: OLD_CHAT, mode: "redirect", now: 1_000 }), { to: "pass" });
  assert.deepEqual(await oldLineNode({ ...redirect, number: "5555550142" }), { to: "pass" });
  for (const chatId of ["chat_1", "photon:+15555550142:+15555550100", "whapi:15555550100@s.whatsapp.net"]) {
    assert.deepEqual(await oldLineNode({ ...redirect, chatId }), { to: "pass" });
  }
});

test("a chat told within the day is held, with no reply; a day later it is told again", async () => {
  assert.deepEqual(await oldLineNode({ ...redirect, lastToldAt: 1_000, now: 1_000 + OLD_LINE_EVERY_MS - 1 }), { to: "hold" });
  assert.deepEqual(await oldLineNode({ ...redirect, lastToldAt: 1_000, now: 1_000 + OLD_LINE_EVERY_MS }), { to: "redirect", answer: TEXT });
});

const post = (body) => new Request("https://gateway/texts/old-line", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("/texts/old-line runs the node on the config's graph and answers its output", async () => {
  const response = await oldLineForTexts(post(redirect));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { to: "redirect", answer: TEXT });
});

test("/texts/old-line refuses a body the node's inSchema does not allow, and a body that is not JSON", async () => {
  for (const body of [{ ...redirect, text: "words never travel here" }, { chatId: OLD_CHAT, now: 1 }, { ...redirect, mode: "sideways" }]) {
    assert.equal((await oldLineForTexts(post(body))).status, 422, JSON.stringify(body));
  }
  assert.equal((await oldLineForTexts(post("{"))).status, 400);
  assert.equal((await oldLineForTexts(new Request("https://gateway/texts/old-line"))).status, 400);
});

test("/texts/old-line passes every text on while the node is off in the config", async () => {
  const off = { runNode: async () => ({ ran: false }) };
  assert.deepEqual(await (await oldLineForTexts(post(redirect), { graph: off })).json(), { to: "pass" });
});
