import assert from "node:assert/strict";
import { parseNoteRun } from "../../../../../packages/tex/gateway/agent/noteRun.js";

export default {
  id: "note-run-reads-loose-json",
  incident:
    "2026-11-21: signed in on a preview, a person asked @Tex in a note's comment for a basic plot outline; the thread showed Tex's whole raw JSON object as its answer and nothing was written into the note.",
  cause:
    "The model quoted a word inside its insert without escaping the quotes, the strict JSON read failed, and the run fell back to posting the raw text as the answer with no edit.",
  path: "note comment",
  async run() {
    const out = parseNoteRun('{"answer": "Added a plot outline after the premise.", "replace": null, "insert": "\\n\\nAct 1\\n- The starter talks about its "ingredients," and her secrets."}');
    assert.equal(out.answer, "Added a plot outline after the premise.", "the answer is the answer, not the object");
    assert.match(out.insert ?? "", /"ingredients,"/, "and the outline is the edit");
  },
};
