import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";
import { isPreviewKey, previewSigningKey } from "../../../../../packages/shared/src/notePreview.cjs";

const ORIGIN = "https://app.example";
/** The note's link as the write's result carried it: the model is shown it and repeats it. */
const linkIn = (body) => JSON.stringify(body ?? {}).match(/link: (https:\/\/[^\s\\]+)/)?.[1] ?? null;

export default {
  id: "note-link-unfurls-with-name",
  incident: "2026-11-23: every note link Tex texted unfurled in iMessage as the same \"A note in Context\" card, whichever note it named, so a chat of links all looked alike.",
  cause: "The router titles only a card it can trust, and a texted note link carried nothing it could trust: no name and no key. A read or write now keeps its link's signed twin, and the finish step swaps it in (`noteLinks.js`, `notePreview.cjs`).",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    chat.world.env.APP_ORIGIN = ORIGIN;
    const write = { name: "write_note", args: { path: "1-projects/romans-8.md", content: "# Romans 8\n\nNo condemnation.\n" } };
    let shown = null;
    try {
      const { answer } = await chat.text("save my notes on romans 8", [
        { toolCalls: [write] },
        (body) => {
          shown = linkIn(body);
          return { text: `Saved: ${shown}` };
        },
      ]);
      assert.ok(shown !== null && !shown.includes("k="), `the model is shown the plain link, never the key (${shown})`);
      const sent = answer.slice("Saved: ".length);
      assert.ok(sent.startsWith(`${shown}?t=Romans%208&k=`), `the texted link carries the note's name and a key (${sent})`);
      const url = new URL(sent);
      const slug = decodeURIComponent(url.pathname.split("/")[2]).slice(1);
      const key = url.searchParams.get("k");
      const signingKey = await previewSigningKey(chat.world.env.GATEWAY_SECRET);
      assert.equal(await isPreviewKey(signingKey, { slug, path: "1-projects/romans-8.md", title: "Romans 8", key }), true, "the key is the one the control plane checks");
      assert.equal(await isPreviewKey(signingKey, { slug, path: "1-projects/romans-8.md", title: "Romans 9", key }), false, "and it fits no other name");
    } finally {
      delete chat.world.env.APP_ORIGIN;
    }
  },
};
