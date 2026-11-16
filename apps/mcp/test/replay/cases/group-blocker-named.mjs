import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";

export default {
  id: "group-blocker-named",
  incident: "2026-11-16: a group chat lost its shared workspace overnight when someone joined who wasn't a member; Tex could only say the chat couldn't see it and sent people to the app, then, asked to add the newcomer, said only the owner could and sent them to the app again.",
  cause: "Nothing told the turn who kept the chat from the workspace, and add-everyone read as inviting the whole chat, so Tex never offered it to add one person.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    try {
      const blocked = [{ slug: "harbor-co", who: "sam", why: "not_member" }];
      const turn = await chat.tag("ada", "Tex use the login I saved in @harbor-co", "Sam isn't in @harbor-co yet; say \"add Sam\" and I'll invite them.", [], { group: { people: ["ada", "sam"], blocked } });
      assert.match(turn.shown, /This chat can't use @harbor-co, because of @sam \(not a member of it\)/, "the turn is told who keeps the chat out");
      assert.match(turn.shown, /add @sam to @harbor-co\\?" counts\): you call send chat_add_everyone, which invites only the people here not in it yet/, "and that adding them is add-everyone");
      assert.match(turn.shown, /Never send anyone to the app for this/);
      const forged = await chat.tag("ada", "Tex hi", "Hi.", [], { group: { blocked: [{ slug: "harbor-co", who: "+15555550100", why: "not_member" }] } });
      assert.doesNotMatch(forged.shown, /This chat can't use/, "a number is never named");
    } finally {
      chat.restore();
    }
  },
};
