import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

/** A small PNG, and the WebP the Images binding hands back for it (`pictureCompression.js`). */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 7)]).toString("base64");
const WEBP = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 "), Buffer.alloc(300, 5)]);

export default {
  id: "texted-picture-seen-later",
  incident:
    "2026-11-23: Seyi texted a screenshot and a link for a mood board. Six hours later Tex said the picture showed in the chat history only as a placeholder and asked him to resend it, three times.",
  cause:
    "The store keeps a texted picture's compressed copy as upload-<hash>.webp (#2575), but Tex kept the name the bytes came in under (upload-<hash>.png), so every later read of it, the week history's included, was not found.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    const restoreImages = chat.world.env.IMAGES;
    chat.world.env.IMAGES = { input: () => { const chain = { transform: () => chain, output: async () => ({ response: () => new Response(WEBP) }) }; return chain; } };
    try {
      await chat.text("save this as visual inspiration", "Saved.", { attachments: [{ name: "IMG_3335.png", mediaType: "image/png", data: PNG }] });
      const later = await chat.text("what was in the picture I sent?", "An ink drawing of a bird.");
      assert.match(later.shown, /\[picture upload-[0-9a-f]{16}\.webp\]/, "the history names the picture by the name the store kept it under");
      assert.ok(later.shown.includes(WEBP.toString("base64")), "and the next text is shown the picture itself, not only its marker");
    } finally {
      chat.world.env.IMAGES = restoreImages;
      chat.restore();
    }
  },
};
