import assert from "node:assert/strict";
import { parsePhotonEvent } from "../../../../../packages/tex/worker/photonInbound.ts";
import { keepSentStickers, stickerOf } from "../../../../../packages/tex/worker/stickers.ts";
import { MemoryStorage } from "../../../../../packages/tex/worker/memoryStorage.testing.ts";

const LINE = "+15555550199";
const FRIEND = "+15555550100";

/** A sticker sent as a message of its own in a group, as the Photon bridge sends it (`map.mjs` `attachment`). */
const sent = {
  seq: 1,
  eventId: "photon:message.received:st-1",
  type: "message.received",
  line: LINE,
  chat: { guid: "any;+;STICKERSALONE01", kind: "group", participants: [FRIEND, "+15555550101"] },
  from: FRIEND,
  fromMe: false,
  at: "2026-11-25T08:09:00.000Z",
  message: { guid: "st-1", text: "", service: "iMessage", attachments: [{ guid: "at_0_SIDE-EYE", name: "sticker.heic", mimeType: "image/heic", size: 900, sticker: true }] },
};

export default {
  id: "sticker-sent-alone",
  incident: "2026-11-25: someone sent a sticker as its own text in a group and asked Tex to use it; Tex said it couldn't reuse it.",
  cause: "Only a sticker stuck on a text was kept: one sent as its own message came in as a plain picture, with no id Tex could name on its tapback.",
  path: "group text",
  // Sabotage (2026-11-25): drop `stickers` in photonInbound.ts received, or the keepSentStickers call, and no id is read.
  async run() {
    const storage = new MemoryStorage();
    const read = parsePhotonEvent(sent, { attachmentUrl: (guid) => `https://files.example/${guid}` });
    assert.equal(read.kind, "group-message");
    assert.deepEqual(read.stickers, ["at_0_SIDE-EYE"], "the sent sticker is carried by its guid");
    const message = await keepSentStickers(storage, read, 1_000);
    const id = /\[sticker (s[0-9a-z]{6})\]$/.exec(message.text)?.[1];
    assert.ok(id, "the message reads the sticker's id, so Tex can name it");
    assert.equal(await stickerOf(storage, id), "at_0_SIDE-EYE", "and the chat kept it to stick back");
    assert.equal("stickers" in message, false, "the guid goes no further than the chat");
  },
};
