import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";
import { keptStickerIds, stickerSending, SEND_STICKER_TOOL } from "../../../../../packages/tex/gateway/agent/stickerSend.js";

const ROBOT = "s0a1b2c";
const CAT = "s3d4e5f";
const kept = { stickers: [ROBOT, CAT], stickerWords: { [ROBOT]: "robot waving; fits a friendly hello" } };

export default {
  id: "sticker-sent-when-tagged",
  incident:
    "2026-11-26, a Lab copy of Battle of the Bots carrying the chat's 7 stickers: \"hey tex could u send me a sticker\" got a drawn robot. Tex thought \"Tex can't send stickers\", and it was right: its only way was the tapback, refused when someone names Tex.",
  cause: "A kept sticker could only ride on the tapback, a turn's whole answer, and the tapback is refused for a named or tagged text, so a direct ask for a sticker had no way to send one.",
  path: "group text that tags Tex",
  // Sabotage (2026-11-26): drop `stickering` from runTheModel.js's local tools and the call is refused; drop
  // `sendSticker` in sendTheReply.js and the Worker is never told to send it; skip the kept check in stickerSend.js and
  // an id from another chat is handed on.
  async run() {
    // Only an id the chat kept goes; another is refused with the chat's own ids as data.
    let chosen = null;
    const local = stickerSending({ kept: keptStickerIds(kept), onChosen: (id) => void (chosen = id) });
    assert.equal(local.tool.name, SEND_STICKER_TOOL);
    const refused = await local.call({ id: "s9z9z9z" });
    assert.equal(refused.isError, true);
    assert.deepEqual(JSON.parse(refused.content[0].text).chatStickers, [ROBOT, CAT]);
    assert.equal(chosen, null);
    assert.notEqual((await local.call({ id: `sticker ${ROBOT}` })).isError, true);
    assert.equal(chosen, ROBOT);

    const chat = await groupChat();
    try {
      const asked = await chat.tag("ada", "hey tex could u send me a sticker", [{ toolCalls: [{ name: "send_sticker", args: { id: ROBOT } }] }, { text: "here you go" }], [], {
        tagged: true,
        group: { people: ["ada", "bo"], cause: "tagged" },
        body: { ...kept, running: [] },
      });
      assert.equal(asked.body.sendSticker, ROBOT, "the Worker is told to send the kept sticker after the words");
      assert.equal(asked.answer, "here you go");
      assert.match(asked.shown, /chatStickers.{0,40}s0a1b2c.{0,40}robot waving; fits a friendly hello/, "the turn is handed the kept stickers as data");

      // A chat with no kept stickers is offered none, and a call names nothing the Worker sends.
      const none = await chat.tag("ada", "tex send a sticker", [{ toolCalls: [{ name: "send_sticker", args: { id: ROBOT } }] }, { text: "I don't have any of this chat's stickers yet." }], [], {
        tagged: true,
        group: { people: ["ada", "bo"], cause: "tagged" },
        body: { running: [] },
      });
      assert.equal(none.body.sendSticker, undefined, "nothing to send where the chat kept none");
    } finally {
      chat.restore();
    }
  },
};
