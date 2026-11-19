import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const ORIGIN = "https://app.example";
/** The note's link as the write's result carried it: the model is shown it and may repeat it. */
const linkIn = (body) => JSON.stringify(body.messages ?? []).match(/link: (https:\/\/[^\s\\]+)/)?.[1] ?? null;

export default {
  id: "saved-note-link",
  incident: "2026-11-19: Tex saved an offboarding checklist with write_note, then texted \"Here it is\" with no link, so the person had to ask for it; the link line in the write's result was there, and the model dropped it.",
  cause: "The write's `link:` line was the model's to pass on, and nothing checked the texted reply. A deliverable save now keeps its link (`noteLinks.js` `saved`), and the reply that does not link it gets the last one's link on its own line (`withSavedLink`, `sendTheReply.js`).",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    chat.world.env.APP_ORIGIN = ORIGIN;
    const content = "# Offboarding checklist\n\n- Revoke app access\n- Collect the laptop\n";
    const write = { name: "write_note", args: { path: "1-projects/offboarding-checklist.md", content } };
    try {
      // The deliverable: a new note, then the bare "Here it is" the model texted. The gateway adds the link.
      const first = await chat.text("make me an offboarding checklist in context, a general one I can reuse", [{ toolCalls: [write] }, { text: "Here it is" }]);
      const link = first.answer.split("\n").at(-1);
      assert.match(link, /^https:\/\/app\.example\/(?:note|p)\/@[^/\s]+\/1-projects\/offboarding-checklist\.md$/, "the reply ends with the saved note's link on its own line");
      assert.equal(first.answer.split("\n")[0], "Here it is", "the words stay as the model wrote them");

      // The model already linked the note: the reply keeps that one link, and none is added.
      const again = await chat.text("make me another offboarding checklist, a short one", [
        { toolCalls: [{ name: "write_note", args: { path: "1-projects/short-offboarding.md", content: "# Short\n\n- Revoke access\n" } }] },
        (body) => ({ text: `Here it is: ${linkIn(body)}` }),
      ]);
      assert.equal(again.answer.split("https://").length - 1, 1, "the link appears exactly once");
      assert.match(again.answer, /^Here it is: https:\/\/app\.example\/(?:note|p)\/@[^/\s]+\/1-projects\/short-offboarding\.md$/);

      // Tex's own memory is not a deliverable: a remembered fact gets no link.
      const remembered = await chat.text("I always want my checklists to list the laptop first", [
        { toolCalls: [{ name: "write_note", args: { path: "tex/about.md", content: "# About\n\n- Lists the laptop first\n" } }] },
        { text: "Got it" },
      ]);
      assert.equal(remembered.answer, "Got it", "no link is added to a reply that saved only Tex's own note");
    } finally {
      delete chat.world.env.APP_ORIGIN;
    }
  },
};
