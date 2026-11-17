import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";

export default {
  id: "group-told-not-known",
  incident: "2026-11-17, Battle of the Bots: a fact the turn was not handed was filled in with a stock sentence or left out, and Tex said what the sentence said (\"you'd just tagged me\") or made up the rest (\"Dev2 can't see this chat\").",
  cause: "Each fact line was a sentence code typed, not one built from the field it describes: a turn with no cause was told \"@<sponsor> tagged you.\", a judged text from an invited person was told \"The person who tagged you\", and a missing sharing state was left out.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    try {
      const unknown = await chat.tag("ada", "and the other one?", "The other one is Thursday.", [], { group: { people: ["ada"] } });
      assert.match(unknown.shown, /Why this turn runs is not known/, "a turn with no cause is told it is not known");
      assert.doesNotMatch(unknown.shown, /@ada tagged you\./, "and never that someone tagged it");
      const tagged = await chat.tag("ada", "Tex what's on Thursday?", "Dinner at 7.", [], { group: { people: ["ada"], cause: "tagged" } });
      assert.match(tagged.shown, /@ada tagged you\./, "a tag is still a tag");
      assert.doesNotMatch(tagged.shown, /Why this turn runs is not known|who sent it is not known/);
      // Main's front door reads the chat's sharing: with no state sent, it says that is not known too.
      assert.match(tagged.shown, /whether the developers who build Tex can read this chat is not known/);
    } finally {
      chat.restore();
    }
  },
};
