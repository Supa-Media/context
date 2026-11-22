import assert from "node:assert/strict";
import { chatMailPrompt } from "../../../../../packages/tex/gateway/agent/groupMail.js";
import { chatCalendarPrompt } from "../../../../../packages/tex/gateway/agent/groupCalendar.js";

export default {
  id: "group-share-prompt-offers",
  incident: "2026-11-22, Lab copy of Tex Devs after the capability fix: asked whether seeing their mail would help, Tex still told the member to type \"Tex, share my mail from your address here\".",
  cause: "The group turn's mail line (the one the turn actually reads, unlike the capability list, which the group front door is not given) told Tex the set phrase to hand out, and the calendar lines never said a yes to Tex's offer is enough.",
  path: "group tag",
  async run() {
    const mail = chatMailPrompt({ mail: [] });
    assert.doesNotMatch(mail, /by typing/, "no phrase to dictate");
    assert.match(mail, /plain yes to your offer is enough: never tell them to type a set phrase/);
    assert.match(chatCalendarPrompt({ calendar: [] }), /plain yes to your offer is enough: never tell them to type a set phrase/);
    assert.match(chatCalendarPrompt({ calendar: [{ handle: "ada", address: "ada@example.com" }] }), /share theirs by asking you \(send action chat_share_calendar\): offer it/, "and with some calendars shared, the others can still be offered");
  },
};
