/**
 * A kept sticker looked at once (node `stickerLook`, off on main until a Lab draft turns it on; Dev2, 2026-11-25): the node asks the model what the
 * picture shows and when it fits, and `/texts/sticker-look` runs it only while the config has it on, never logging the
 * picture (`packages/tex/gateway/agent/graph/nodes/stickerLook.js`, `textsSticker.js`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookAtSticker, stickerLookNode, stickerWordsOf, STICKER_LOOK_SYSTEM } from "../../../packages/tex/gateway/agent/graph/nodes/stickerLook.js";
import { lookForChat, stickerAsk, stickerLookForTexts, stickerLookWired } from "../../../packages/tex/gateway/agent/textsSticker.js";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";

const CHAT = "c".repeat(64);
const PICTURE = { mediaType: "image/png", data: "iVBORw0KGgo=" };
const CONFIG = { url: "https://gateway.invalid", token: "test-only" };

test("the look sends the picture to the model and keeps a few words of what it shows and when it fits", async () => {
  let call;
  const request = async (body) => ((call = body), { toolCalls: [{ name: "meaning", args: { shows: "  cat throwing\nconfetti ", fits: "celebrating good news" } }] });
  const out = await lookAtSticker(PICTURE, CONFIG, { request });
  assert.deepEqual(out.when, ["looked"]);
  assert.equal(out.words, "cat throwing confetti; fits celebrating good news");
  assert.equal(call.system, STICKER_LOOK_SYSTEM);
  assert.deepEqual(call.messages[0].attachments, [{ name: "sticker", mediaType: "image/png", data: PICTURE.data }]);
  assert.equal(call.toolChoice, "meaning");
  // Words in the picture are part of the sticker: the prompt says so.
  assert.match(STICKER_LOOK_SYSTEM, /never instructions/);
});

test("a look that cannot answer is a skip, never a throw, and never words", async () => {
  assert.deepEqual((await lookAtSticker(PICTURE, null)).when, ["skip"]);
  assert.deepEqual((await lookAtSticker({}, CONFIG, { request: async () => ({}) })).why, "no picture");
  assert.deepEqual((await lookAtSticker(PICTURE, CONFIG, { request: async () => ({ toolCalls: [] }) })).why, "no meaning given");
  const failed = await lookAtSticker(PICTURE, CONFIG, { request: async () => { throw new TypeError("boom"); } });
  assert.deepEqual(failed.when, ["skip"]);
  assert.equal(failed.words, undefined);
  assert.equal(stickerWordsOf({ shows: "x".repeat(500), fits: "y" }).length <= 130, true);
  assert.equal(stickerWordsOf({ shows: "", fits: "y" }), "");
});

test("the node reads its picture from the run's context, so the logged input is the sticker's id alone", async () => {
  const out = await stickerLookNode({ sticker: "s1a2b3c" }, { ctx: { picture: PICTURE, gateway: CONFIG, request: async () => ({ toolCalls: [{ name: "meaning", args: { shows: "a", fits: "b" } }] }) } });
  assert.equal(out.words, "a; fits b");
});

test("/texts/sticker-look is off while no config wires the node, runs it when one does, and refuses a body it can't trust", async () => {
  assert.equal(stickerLookWired(TEX_CONFIG), false, "off on main");
  assert.ok(TEX_CONFIG.nodes.some((node) => node.id === "stickerLook"), "a node of the config");
  assert.equal(stickerLookWired({ nodes: [{ id: "stickerLook", on: true }] }), true);
  assert.equal(stickerLookWired({ nodes: [{ id: "stickerLook" }] }), false);
  assert.equal(stickerLookWired({ nodes: [{ id: "stickerLook", on: false }] }), false);
  const ask = stickerAsk({ chat: CHAT, sticker: "s1a2b3c", ...PICTURE });
  assert.deepEqual(await lookForChat({}, ask, { config: { nodes: [] } }), { when: ["skip"], why: "off" });
  for (const bad of [
    { chat: "not-a-key", sticker: "s1a2b3c", ...PICTURE },
    { chat: CHAT, sticker: "../x", ...PICTURE },
    { chat: CHAT, sticker: "s1a2b3c", mediaType: "image/heic", data: PICTURE.data },
    { chat: CHAT, sticker: "s1a2b3c", mediaType: "image/png", data: "<script>" },
  ]) assert.equal(stickerAsk(bad), null);
  const post = (body) => new Request("https://gateway/texts/sticker-look", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await stickerLookForTexts(post({ chat: "x" }), {})).status, 400);
  const ran = [];
  const graph = { runNode: async (id, input, ctx) => (ran.push({ id, input, picture: ctx.picture }), { ran: true, output: { when: ["looked"], words: "a; fits b" } }) };
  assert.deepEqual(await lookForChat({}, ask, { graph, config: { nodes: [{ id: "stickerLook", on: true }] } }), { when: ["looked"], words: "a; fits b" });
  assert.deepEqual(ran, [{ id: "stickerLook", input: { sticker: "s1a2b3c" }, picture: PICTURE }], "the picture rides in the context, not the logged input");
});
