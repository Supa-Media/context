import assert from "node:assert/strict";
import { noteRunQuestion, runNoteRun } from "../../../../../packages/tex/gateway/agent/noteRun.js";

/** A Workers AI binding that answers once with `text`, as the built-in model's tests do. */
function oneReply(text) {
  return {
    async run(_model, input) {
      if (input?.questions?.route) return { answers: {} };
      return { choices: [{ message: { content: text, tool_calls: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } };
    },
  };
}

const NOTE = "# Words\n\nkind\nquiet\nbrave\n";

export default {
  id: "note-run-carries-on-line",
  incident:
    "2026-11-21: in a note of single words, a person highlighted one word on its own line and asked @Tex for a haiku starting with that word; the haiku landed under a blank line, repeating the word, instead of carrying on from it.",
  cause:
    "The run's addition was always joined under a blank line when it ran several lines or the word ended its line (withInsert's fixed rule), and the run was never told it could carry on from the highlighted words, so it wrote them again. Where the words go is now the run's call: it begins the addition with a space, a newline or a blank line.",
  path: "note comment",
  async run() {
    const anchor = { text: "quiet", before: "# Words\n\nkind\n", after: "\nbrave\n" };
    const question = noteRunQuestion({ path: "Words.md", noteText: NOTE, anchor, ask: "write a haiku starting with this word", history: [], pending: null, chatHistory: "", audience: "only you" });
    assert.match(question, /joined right after the highlighted words exactly as you write it/, "the run is told its addition is joined as written");
    assert.match(question, /never write them again/, "and that carrying on from the words means not repeating them");

    const steps = [];
    const controlPlane = { async startBuiltinTurn() { return { allowed: true }; }, async recordBuiltinUsage() {} };
    const out = await runNoteRun({
      env: { AI: oneReply('{"answer":"Wrote a haiku that starts from it.","replace":null,"insert":" rain on the tin roof\\nthe kettle starts to murmur\\nnobody hurries"}') },
      controlPlane,
      session: { accessToken: "tok", workspaceId: "ws_replay", workspaceKind: "personal", scopes: ["context:read"] },
      dispatch: async () => ({ content: [] }),
      offered: [],
      path: "Words.md",
      noteText: NOTE,
      anchor,
      ask: "write a haiku starting with this word",
      node: { model: "haiku-5-5", rounds: 2 },
      now: Date.parse("2026-11-21T11:30:00Z"),
      timeZone: "UTC",
      onStep: (step) => steps.push(step),
    });
    assert.equal(out.outcome, "answered");
    assert.equal(out.replace, "quiet rain on the tin roof\nthe kettle starts to murmur\nnobody hurries", "the haiku carries on from the word on its own line, with no blank line");
    assert.equal(steps.find((s) => s.id === "step-think" && s.state === "done")?.label, "Writing after the selected words");
  },
};
