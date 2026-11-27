import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "unanswered-before-tag",
  incident:
    "2026-11-21 (a team's group chat): Tex posted a reminder, someone asked a question its judge took as meant for the others, " +
    "then texted only Tex's name half a minute later. Tex answered \"Hey. What do you need?\", as if the question had never been asked. " +
    "And 2026-11-27, launch-day rehearsal (a Lab test chat, invented people): Tex asked which area to search for a cabin, the answer came, and Tex's thinking read it as a new question and offered to search instead of searching.",
  cause:
    "Within an hour of activity the chat's last turns are carried as pairs of a question and Tex's answer (stretch.js), and the log block stops where they begin. " +
    "A text after the last answer that no turn took was in neither, so the model never saw it. " +
    "Tex's own question was in the history, but no turn was told Tex was still waiting on it: only the judge read it (`packages/tex/worker/events.ts` `renderTranscript`).",
  path: "1:1 texts in a stretch",
  async run() {
    const chat = await oneToOne();
    // The chat's clock brought up to the gateway's, so the texts and Tex's turns are one stretch (it starts two hours back).
    chat.later(2 * 60 * 60_000 - 10 * 60_000);
    try {
      await chat.text("anything due this week?", "The ticket money is due Friday.");
      // A text no turn took (in a group: the judge said it wasn't for Tex). The Worker keeps it; nothing answers it.
      await chat.keep({ text: "Does anyone still owe for the tickets?" });
      const tagged = await chat.text("Tex", "Only Bo.");
      assert.match(tagged.shown, /Does anyone still owe for the tickets\?/, "the unanswered text reaches the next turn");
      assert.equal(tagged.shown.split("Does anyone still owe for the tickets?").length - 1, 1, "once");
      assert.match(tagged.shown, /The ticket money is due Friday\./, "beside the answer before it");
      // Tex's own open question (`openQuestion.js`). Sabotage (2026-11-27): drop `openQuestionFact` from
      // `runTheModel.js` `turnNote` and the next assertion fails.
      await chat.text("find us a cabin for next weekend", "On it. What area should I search?");
      const answer = await chat.text("poconos, driving distance from nyc", "Searching Poconos cabins now.");
      assert.match(answer.shown, /your_open_question[\\"]+:[\\"]+What area should I search\?/, "the answer's turn is told what Tex asked");
      const next = await chat.text("thanks", "Anytime.");
      assert.doesNotMatch(next.shown, /your_open_question/, "a reply that asked nothing leaves no open question");
    } finally {
      chat.restore();
    }
  },
};
