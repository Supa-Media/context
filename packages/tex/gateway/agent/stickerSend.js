/**
 * A sticker this chat kept, sent as a picture of its own after Tex's words, or as its whole answer (Dev2, 2026-11-26,
 * chose "Own send action for stickers": "it should just reply with stickers instead, like a regular image").
 *
 * The tapback could already carry a sticker, but only as a turn's whole answer, and a tapback is refused when someone
 * names Tex. In a Lab copy of Battle of the Bots, "hey tex could u send me a sticker" got a drawn robot: the model
 * thought, rightly, that it had no way to send one. This action is that way, offered on a chat turn while the chat kept
 * stickers and its "Chat stickers" setting (`tapback.stickers`) is on, named or not.
 *
 * Its results are facts as data. The id is checked against the chat's kept stickers (`body.stickers`, from
 * `packages/tex/worker/stickers.ts` `stickersAsk`), and the Worker checks it again before it sends (`stickerOf`).
 */

import { stickerIdOf } from "./tapbackEnding.js";

export const SEND_STICKER_TOOL = "send_sticker";

export const SEND_STICKER_DEFINITION = {
  name: SEND_STICKER_TOOL,
  description:
    "Send one sticker this chat kept (chatStickers, by id) as a picture of its own, after your words or as your whole answer. " +
    "Allowed when they tagged you.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The sticker's id, as chatStickers names it (s1a2b3c)." },
    },
    required: ["id"],
  },
};

/** The kept sticker ids a turn may send: the chat's own, as the Worker handed them. */
export function keptStickerIds(body) {
  return Array.isArray(body?.stickers) ? [...new Set(body.stickers.map(stickerIdOf).filter((id) => id !== null))] : [];
}

const result = (fact, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(fact) }] });

/** The local tool, and the sticker it chose (`onChosen`, once a call names a kept one; the last call wins). */
export function stickerSending({ kept, onChosen }) {
  const ids = new Set(kept);
  return {
    tool: SEND_STICKER_DEFINITION,
    call: async (args = {}) => {
      const id = stickerIdOf(args.id);
      if (id === null || !ids.has(id)) return result({ sticker: id, kept: false, chatStickers: [...ids] }, true);
      onChosen(id);
      return result({ sticker: id, sends: "after your words" });
    },
  };
}
