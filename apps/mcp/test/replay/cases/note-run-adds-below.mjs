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

const PREMISE = "A film retelling an old story, set in 2025";

export default {
  id: "note-run-adds-below",
  incident:
    "2026-11-21: in a note's comments, a person highlighted a one-line film premise and asked @Tex \"give me a basic plot outline here\"; Tex wrote the outline as its answer in the thread and changed nothing in the note.",
  cause:
    "A note run's only edit was the highlighted words' whole new text, and it was told to edit only when the ask was to change those words. An outline belongs after the premise, so no edit fit and the run answered instead.",
  path: "note comment",
  async run() {
    const question = noteRunQuestion({ path: "Pitch.md", noteText: `# Pitch\n\n${PREMISE}\n`, anchor: { text: PREMISE, before: "# Pitch\n\n", after: "\n" }, ask: "give me a basic plot outline here", history: [], pending: null, chatHistory: "", audience: "only you" });
    assert.match(question, /"insert"/, "the run is offered an addition after the words");
    assert.match(question, /do it in the note/, "and told an ask for content is done in the note");

    const steps = [];
    const controlPlane = { async startBuiltinTurn() { return { allowed: true }; }, async recordBuiltinUsage() {} };
    const out = await runNoteRun({
      env: { AI: oneReply('{"answer":"Added an outline under the premise.","replace":null,"insert":"1. Framed\\n2. Thrown to the lions\\n3. Vindicated"}') },
      controlPlane,
      session: { accessToken: "tok", workspaceId: "ws_replay", workspaceKind: "personal", scopes: ["context:read"] },
      dispatch: async () => ({ content: [] }),
      offered: [],
      path: "Pitch.md",
      noteText: `# Pitch\n\n${PREMISE}\n`,
      anchor: { text: PREMISE, before: "# Pitch\n\n", after: "\n" },
      ask: "give me a basic plot outline here",
      node: { model: "haiku-5-5", rounds: 2 },
      now: Date.parse("2026-11-21T03:34:27Z"),
      timeZone: "UTC",
      onStep: (step) => steps.push(step),
    });
    assert.equal(out.outcome, "answered");
    assert.equal(out.replace, `${PREMISE}\n\n1. Framed\n2. Thrown to the lions\n3. Vindicated`, "the premise stays and the outline lands under it, as a suggestion to keep");
    assert.equal(steps.find((s) => s.id === "step-think" && s.state === "done")?.label, "Adding below the selected words");
  },
};
