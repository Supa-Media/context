import assert from "node:assert/strict";
import { sixToolsOver } from "../../../src/agent/sixTools.js";
import { wordsOf } from "../../../../../scripts/tex-prompt-module.mjs";

const tool = (name) => ({ name, description: `${name}.`, inputSchema: { type: "object", properties: {} } });
const searchOf = (names) => sixToolsOver(names.map(tool)).tools.find((t) => t.name === "search");

export default {
  id: "search-names-google-chat",
  incident: "2026-11-19 (Training trial-hire): asked \"you can see the feedback we sent right?\", Tex searched notes and Gmail, answered from an email, and never read the Google Chat message that held the feedback; asked to end a trial \"I told him at the start it was a 2 week trial\", it repeated the claim as settled without looking it up.",
  cause: "search covers notes and mail but not Google Chat, which only fetch chat: reads, and nothing told Tex so; the reply check listed only notes, mail and earlier texts as the record to check a claim against, and never asked it to say what rests only on the person's memory.",
  path: "one-to-one text",
  // Sabotage (2026-11-19): drop the `chat` line in sixTools.js searchTool, or put rules.md item 8 back, and this fails.
  async run() {
    const own = searchOf(["search_notes", "read_note", "read_google_chat"]);
    assert.match(own.description, /Google Chat is not in this search/, "a turn that reads their Chat is told search does not cover it");
    assert.match(own.description, /fetch id "chat:"/, "and how to read it");
    const group = searchOf(["search_notes", "read_note", "earlier_chat"]);
    assert.doesNotMatch(group.description, /Google Chat/, "a group turn, which never reads their Chat, is not told to");
    const rules = wordsOf().rules;
    assert.match(rules, /their Google Chat, their calendar/, "a claim is checked in every place that could hold it");
    assert.match(rules, /what rests only on their memory/, "and what the record does not back is said as such");
  },
};
