import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";

export default {
  id: "group-told-why",
  incident: "2026-11-14 and 2026-11-17, Battle of the Bots: the chat's own check-in texted \"Yeah, what do you need?\" every four hours with nothing asked, and asked why, Tex said \"you'd just tagged me\" about a message nobody tagged. Every group turn was also told the chat's history is in \"their personal workspace\".",
  cause: "No group turn was told whether the chat was shared with the developers, and every group turn was told \"@<sponsor> tagged you.\" whatever ran it (a check-in, a routine, a follow-up the judge picked up), and the 1:1's own record, check-in and ping words were put in group turns too.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    try {
      const look = await chat.tag("ada", "(Time for this chat's check-in: look on your own at what is new. If nothing needs the chat, answer exactly SKIP.)", "SKIP", [], { group: { people: ["ada"], cause: "check_in" } });
      assert.match(look.shown, /Nobody texted you: this is the chat's own check-in/, "a check-in is told it is one");
      assert.doesNotMatch(look.shown, /@ada tagged you\./, "and never that someone tagged it");
      const followUp = await chat.tag("ada", "and the other one?", "The other one is Thursday.", [], { group: { people: ["ada"], cause: "judged" } });
      assert.match(followUp.shown, /@ada's newest text doesn't name you/, "a follow-up the judge handed over says nobody named Tex");
      assert.match(followUp.shown, /never say they did/);
      const tagged = await chat.tag("ada", "Tex what's on Thursday?", "Dinner at 7.", [], { group: { people: ["ada"], cause: "named" } });
      assert.match(tagged.shown, /@ada tagged you\./, "a text that names Tex is still a tag");
      // The 1:1-only blocks never reaching a group turn is proven in test/devShare.test.mjs: this harness keeps no ledger.
      // The chat's sharing with the developers, as the control plane counted it (main's front door reads `devShare`).
      const shared = await chat.tag("ada", "Tex can the devs see this chat?", "Yes.", [], { group: { people: ["ada"], cause: "named", devShare: { shared: true, by: ["ada"], waiting: [] } } });
      assert.match(shared.shown, /this chat is shared with the developers who build Tex \(@ada said yes\)/, "a shared chat is told it is shared");
      const waiting = await chat.tag("ada", "Tex can the devs see this chat?", "Not yet.", [], { group: { people: ["ada"], cause: "named", devShare: { shared: false, by: ["ada"], waiting: ["bo"] } } });
      assert.match(waiting.shown, /is not shared[\s\S]*Still to say yes: @bo\./, "and one that isn't, who still has to say yes");
    } finally {
      chat.restore();
    }
  },
};
