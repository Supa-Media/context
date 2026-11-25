import assert from "node:assert/strict";
import { architectureFor } from "../../../../../packages/tex/gateway/agent/texArchitecture.js";
import { cardsPrompt } from "../../../../../packages/tex/gateway/agent/memberCards.js";

export default {
  id: "group-member-cards-told",
  incident: "2026-11-24, friend-test-birthday (Dev set): planning a surprise 30th, the group's Tex suggested a bar crawl to a chat with a friend who is sober and asked again for what every person had told their own Tex, because a group turn knew nothing about its people.",
  cause: "A group turn read no member's card; with member cards promoted (docs/decisions/texting-assistant/member-cards.md) it is told what it may use and that it never says it.",
  path: "group tag",
  async run() {
    // The map names the step ("- Member cards (code, no model)") and the capability ("- Member cards: what each ..."); the
    // capability line is the one that says what the group may do with them.
    const line = architectureFor("group").split("\n").find((entry) => entry.startsWith("- Member cards:"));
    assert.ok(line, "the group turn is told about member cards");
    assert.match(line, /never quote a card, explain it, hint at the reason behind it or say who told you/);
    const told = cardsPrompt({ asked: 1, cards: [{ handle: "kofi", lines: ["Prefers places with good non-drinking options"] }] });
    assert.match(told, /@kofi: Prefers places with good non-drinking options/);
    assert.match(told, /add an option that works for that person too/);
    assert.match(told, /Never quote one, explain one, hint at the reason behind one/);
  },
};
