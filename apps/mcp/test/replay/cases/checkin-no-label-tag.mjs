import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const ALERT = {
  address: "ada@example.invalid",
  id: "alert-1",
  date: "Fri, 27 Nov 2026 22:32:00 +0000",
  from: "Example Social <alerts@example.invalid>",
  to: "ada@example.invalid",
  subject: "New login to your account",
  snippet: "We noticed a login from a new device: a Linux browser. Was this you?",
};

const FOUND = "- [today] New login alert for Ada's account from a Linux browser · their email, 5:32 pm · no offer; ask whether it was them";
const TAGGED = "[check-in] Example Social sent a new-login alert at 5:32 pm, from a Linux browser. Was that you? If not, change the password.";
const PLAIN = "Example Social sent a new-login alert at 5:32 pm, from a Linux browser. Was that you? If not, change the password.";

export default {
  id: "checkin-no-label-tag",
  incident:
    "2026-11-27 6:01 PM ET, a real 1:1 check-in went out as \"[check-in] Two things to check. X sent a new-login alert…\". " +
    "No code wrote the tag: the look's model opened its text with it, and the claim checks and the reviewer let it go.",
  cause:
    "The look was shown bracketed tags at the start of line after line (the research brief's \"- [today] …\", the recent texts' \"[1] You (a check-in) …\") " +
    "and told to open its answer with \"[continues N]\", a marker \"never shown to them\". Only that exact marker was taken off.",
  path: "1:1 check-in with a research finding",
  async run() {
    const chat = await oneToOne();
    try {
      const ran = await chat.checkIn([{ text: TAGGED }, { text: PLAIN }], { mail: [ALERT], research: [{ text: FOUND }] });
      const look = ran.shown;
      assert.match(look, /- today · New login alert/, "the look reads the finding's urgency as a plain field");
      assert.doesNotMatch(look, /- \[today\]/, "never as a bracketed tag at the start of a line");
      assert.doesNotMatch(look, /\[continues N\]/, "and is never told a bracketed marker is hidden");
      assert.match(look, /line_opens_with\W+\[check-in\]/, "the tagged draft went back with what it opens with, as a fact");
      assert.equal(ran.answer, PLAIN, "what reaches them opens with the news, not a label");
    } finally {
      chat.restore();
    }
  },
};
