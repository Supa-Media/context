import assert from "node:assert/strict";
import { noteRunQuestion } from "../../../../../packages/tex/gateway/agent/noteRun.js";

const NOTE = [
  "# Learning notes",
  "",
  "This note is for <!--c:acvi-->what I read this week<!--/c:acvi-->.",
  "",
  "```comments",
  'acvi "what I read this week"',
  "- 2026-11-21T05:40:40Z @alpha: @Tex give me a basic outline here",
  "```",
  "",
].join("\n");

export default {
  id: "note-run-hides-comment-block",
  incident:
    "2026-11-21: signed in on a preview, a person highlighted words in a note and asked @Tex for a basic outline; Tex's edit, now written straight into the note, carried a copy of the note's comments block, so the thread's lines appeared as note text.",
  cause:
    "A note run was shown the note's raw text, comments block and anchor markers included, as \"its words\"; the model treated the thread as part of the note and reproduced it in the edit.",
  path: "note comment",
  async run() {
    const question = noteRunQuestion({
      path: "areas/learning/notes.md",
      noteText: NOTE,
      anchor: { text: "what I read this week", before: "# Learning notes\n\nThis note is for ", after: ".\n" },
      ask: "give me a basic outline here",
      history: [{ who: "@alpha", body: "@Tex give me a basic outline here" }],
      pending: null,
      chatHistory: "",
      audience: "only you",
    });
    assert.match(question, /This note is for what I read this week\./, "the note's own words are there, markers gone");
    assert.doesNotMatch(question, /```comments/, "the comments block is not shown as the note");
    assert.doesNotMatch(question, /acvi "what I read this week"/, "nor its thread header");
  },
};
