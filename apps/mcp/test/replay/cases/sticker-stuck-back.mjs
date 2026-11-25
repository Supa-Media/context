import assert from "node:assert/strict";
import { parsePhotonEvent } from "../../../../../packages/tex/worker/photonInbound.ts";
import { reactionLine } from "../../../../../packages/tex/worker/reactions.ts";
import { keepSentStickers, keepSticker, stickerOf } from "../../../../../packages/tex/worker/stickers.ts";
import { tapback } from "../../../../../packages/tex/worker/stepEvents.ts";
import { MemoryStorage } from "../../../../../packages/tex/worker/memoryStorage.testing.ts";
import { groupLineFor } from "../../../../../packages/tex/worker/groupLine.ts";
import { remoteLine } from "../../../../../packages/tex/worker/remoteLine.ts";
import { tapbackEnding, tapbackStickerOf, TAPBACK_TOOL } from "../../../../../packages/tex/gateway/agent/tapbackEnding.js";
import { tapbackNode } from "../../../../../packages/tex/gateway/agent/graph/nodes/tapback.js";
import { fixedCarriers } from "../../../../../packages/tex/gateway/agent/sixToolsFixed.js";

const LINE = "+15555550199";
const FRIEND = "+15555550100";
const CHAT_GUID = "any;+;STICKERS0123456";
const GROUP = `photon-group:${btoa(CHAT_GUID).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

/** A sticker someone stuck on Tex's text in a group, as the Photon bridge sends it (`map.mjs` `stickerPlaced`). */
const stuck = {
  seq: 1,
  eventId: "photon:message.stickerPlaced:tex-1:7",
  type: "message.reactionAdded",
  line: LINE,
  chat: { guid: CHAT_GUID, kind: "group", participants: [FRIEND, "+15555550101"] },
  from: FRIEND,
  fromMe: false,
  at: "2026-11-25T05:00:00.000Z",
  reaction: { kind: "sticker", targetGuid: "tex-1", targetText: "we're officially booked for Lisbon", targetFromMe: true, sticker: "at_0_PARTY-CAT" },
};

/** A sticker sent as a message of its own in a group, as the Photon bridge sends it (`map.mjs` `attachment`). */
const alone = {
  seq: 2,
  eventId: "photon:message.received:st-1",
  type: "message.received",
  line: LINE,
  chat: { guid: CHAT_GUID, kind: "group", participants: [FRIEND, "+15555550101"] },
  from: FRIEND,
  fromMe: false,
  at: "2026-11-25T08:09:00.000Z",
  message: { guid: "st-1", text: "", service: "iMessage", attachments: [{ guid: "at_0_SIDE-EYE", name: "sticker.heic", mimeType: "image/heic", size: 900, sticker: true }] },
};

export default {
  id: "sticker-stuck-back",
  incident: "2026-11-25: Dev2 asked whether Tex can send stickers through Photon. Tex could read a sticker stuck on a text only as \"with a sticker\", and could never stick one. Then someone sent a sticker as its own text and asked Tex to use it; Tex said it couldn't reuse it.",
  cause: "The bridge dropped the placed sticker's attachment, the chat kept nothing to stick again, and Tex's tapback could only be one of 64 emoji; then the fixed tool list showed the tapback without its sticker choice, and a 1:1 served from the gateway offered no stick unless its id was Photon's. A sticker sent as its own message came in as a plain picture, with no id Tex could name.",
  path: "group text",
  // Sabotage (2026-11-25): drop `sticker` in photonInbound.ts reactionOf, or the stickerOf check in stepEvents.ts
  // tapback, and the sticker is never kept, or an id from another chat is stuck; drop `sticker` from TAPBACK_DEFINITION
  // and the shown tapback offers none; drop `stickers` in photonInbound.ts received, or the keepSentStickers call, and a
  // sticker sent alone reads no id.
  async run() {
    const storage = new MemoryStorage();
    const read = parsePhotonEvent(stuck);
    assert.equal(read.kind, "group-message");
    const kept = await keepSticker(storage, read.reaction, 1_000);
    const id = kept.emoji.replace(/^sticker /, "");
    assert.match(reactionLine(kept, true), new RegExp(`^sticker ${id} on Tex's message "we're officially booked for Lisbon"$`), "the chat's record names the sticker by its id");
    assert.equal(await stickerOf(storage, id), "at_0_PARTY-CAT");

    // A sticker sent as its own text is kept too, and its message reads its id; the guid goes no further than the chat.
    const sentAlone = parsePhotonEvent(alone, { attachmentUrl: (guid) => `https://files.example/${guid}` });
    assert.deepEqual(sentAlone.stickers, ["at_0_SIDE-EYE"], "the sent sticker is carried by its guid");
    const message = await keepSentStickers(storage, sentAlone, 1_500);
    const aloneId = /\[sticker (s[0-9a-z]{6})\]$/.exec(message.text)?.[1];
    assert.ok(aloneId, "the message reads the sticker's id, so Tex can name it");
    assert.equal(await stickerOf(storage, aloneId), "at_0_SIDE-EYE", "and the chat kept it to stick back");
    assert.equal("stickers" in message, false, "the guid goes no further than the chat");

    // The tool list the model is shown is fixed per kind of chat (`sixToolsFixed.js`): its tapback must offer the
    // sticker in a 1:1 and in a group, or Tex never names one (2026-11-25 Lab test: "I can't copy the sticker").
    for (const kind of ["one", "group"]) assert.equal(fixedCarriers(kind).get(TAPBACK_TOOL)?.inputSchema?.properties?.sticker?.type, "string", `${kind}: the shown tapback offers a sticker`);

    // Chat stickers on: Tex's tapback names the sticker, and its answer carries it beside the emoji.
    const ending = tapbackEnding({ gate: tapbackNode, stickers: true });
    await ending.local.call({ emoji: "🎉", sticker: `sticker ${id}` }, { messages: [] });
    assert.equal(tapbackStickerOf({ answer: ending.endsTurn(TAPBACK_TOOL), settled: TAPBACK_TOOL }), id);

    // The Worker sticks the kept sticker on the text, on Photon's line.
    const calls = [];
    const photon = {
      fetch: async (url, init) => {
        calls.push({ op: new URL(url).pathname.slice(1), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ ok: true, guid: "g-1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const line = groupLineFor({ fetch: globalThis.fetch, photon }, GROUP);
    const place = { line: LINE, groupId: GROUP };
    const sent = await tapback(storage, { chat: GROUP, now: () => 2_000, by: "tex", asked: "🎉" }, "LETS GOOO", (emoji) => line.react(place, "friend-2", emoji), { id, stick: (guid) => line.stick(place, "friend-2", { attachment: guid }) });
    assert.equal(sent, `sticker ${id}`);
    assert.deepEqual(calls, [{ op: "sticker", body: { line: LINE, chat: CHAT_GUID, guid: "friend-2", sticker: "at_0_PARTY-CAT" } }]);

    // A 1:1 served from the gateway asks its far line, whatever the chat's id: a Lab test chat's is no photon: id, and
    // its sticker went as the emoji, sticker_no_line (2026-11-25).
    const asked = [];
    const far = remoteLine({ lineCall: async (call) => (asked.push(call.method), { ok: true, value: undefined }) }, "inbox", "lab:test-chat");
    await far.stick("lab:test-chat", "m1", { attachment: "at_0_PARTY-CAT" });
    assert.deepEqual(asked, ["stick"]);

    // A sticker this chat never kept goes as the emoji, never stuck.
    calls.length = 0;
    await tapback(storage, { chat: GROUP, now: () => 3_000, by: "tex", asked: "🎉" }, "again", (emoji) => line.react(place, "friend-3", emoji), { id: "s000000", stick: (guid) => line.stick(place, "friend-3", { attachment: guid }) });
    assert.deepEqual(calls.map((call) => call.op), ["react"]);
  },
};
