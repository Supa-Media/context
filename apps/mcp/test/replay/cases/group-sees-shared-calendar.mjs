import assert from "node:assert/strict";
import { chatLookQuestion } from "../../../../../packages/shared/src/groupRunQuestions.cjs";
import { groupChat } from "../chats.mjs";

export default {
  id: "group-sees-shared-calendar",
  incident: "2026-11-19, Training (an invented food-truck crew): a member's calendar had the wedding on Saturday while the chat planned around Sunday, and the chat's check-in stayed quiet.",
  cause: "A group turn could read no calendar at all (the control plane refused every group grant), its prompt said nobody's calendar can be read from a group, and the check-in words looked at mail only, so nothing held a calendar against what the chat said.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    try {
      const look = chatLookQuestion(undefined, null);
      assert.match(look, /calendars shared with this chat \(read_calendar/, "the check-in looks at shared calendars");
      assert.match(look, /disagrees with the chat[\s\S]*one short question to the person it's about/, "and asks about a clash rather than staying quiet");
      const shared = await chat.tag("ada", "Tex is Bo free Saturday?", "Bo's calendar has a wedding Saturday.", [], {
        group: { people: ["ada", "bo"], cause: "named", calendar: [{ handle: "bo", address: "bo@example.com" }] },
      });
      assert.match(shared.shown, /calendars shared with it: @bo's bo@example\.com/, "a chat with a shared calendar is told whose");
      assert.doesNotMatch(shared.shown, /Nobody's personal notes, calendar/, "and never that no calendar can be read here");
      const none = await chat.tag("ada", "Tex are you there?", "Here.", [], { group: { people: ["ada", "bo"], cause: "named" } });
      assert.match(none.shown, /Nobody's calendar is shared with this chat yet[\s\S]*chat_share_calendar/, "a chat with none is told how its own person shares one");
    } finally {
      chat.restore();
    }
  },
};
