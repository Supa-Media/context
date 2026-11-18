import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { groupChat } from "../chats.mjs";

const require = createRequire(import.meta.url);
const { chatLookQuestion, chatRoutineQuestion } = require("../../../../../packages/shared/src/groupRunQuestions.cjs");

const quiet = { toolCalls: [{ name: "say_nothing", args: { why: "nothing new" } }] };
// A scheduled look reads before it answers, as production's did (`recordRead.js` sends back one that didn't).
const looked = { toolCalls: [{ name: "search", args: { query: "new mail for this chat" } }] };
const checkIn = { group: { people: ["ada"], cause: "check_in" } };
const routine = { group: { people: ["ada"], cause: "routine" } };

/** Nothing reaches the chat: no words, and the flag the Worker reads as "send nothing". */
function textedNothing(turn, why) {
  assert.equal(turn.answer, "", `${why}: no words are handed to the Worker`);
  assert.equal(turn.body.quiet, true, `${why}: the turn says quiet as a flag, never as a word`);
}

export default {
  id: "scheduled-skip-never-texted",
  incident:
    "2026-11-17 23:00 UTC, a WhatsApp group: the chat's own check-in found no new mail and posted its reasoning with the quiet word at the end (\"Nothing new in the shared mailbox ... Nothing needs the group now. SKIP\").",
  cause:
    "A group's check-in and routine were told to type the word SKIP for silence, and the gateway and the Worker each read only a bare SKIP as quiet. One that came after a sentence of reasoning was a text like any other.",
  path: "a group check-in with nothing new",
  async run() {
    const chat = await groupChat();
    try {
      const look = chatLookQuestion(undefined, null);
      // What the chat's scheduled turns are asked: silence is the say_nothing call, and no word is ever asked for.
      const asked = await chat.tag("ada", look, [looked, quiet], [], checkIn);
      textedNothing(asked, "a check-in that calls say_nothing");
      assert.match(asked.shown, /call send with action say_nothing/, "a check-in is told to stay quiet with the call");
      assert.doesNotMatch(asked.shown, /answer exactly SKIP|when to answer SKIP/, "and never to type a word for it");
      assert.doesNotMatch(chatRoutineQuestion("routines/rent.md"), /SKIP/, "nor is a chat routine");

      // The incident: the model explains why it is quiet and then says the word. Decided as quiet, by code.
      const explained = await chat.tag("ada", look, [looked, { text: "Nothing new in the shared folder since 5:52 PM, and nobody here is waiting on an answer. Nothing needs the group now. SKIP" }], [], checkIn);
      textedNothing(explained, "a check-in's reasoning that ends in SKIP");
      const onItsOwnLine = await chat.tag("ada", look, [looked, { text: "No new mail, and no follow-up is owed.\n\nSKIP" }], [], checkIn);
      textedNothing(onItsOwnLine, "a check-in's reasoning with SKIP on a last line");
      const leading = await chat.tag("ada", chatRoutineQuestion("routines/rent.md"), [looked, { text: "SKIP. Rent isn't due this week." }], [], routine);
      textedNothing(leading, "a routine's SKIP that opens its reasoning");

      // A scheduled turn with something to say still says it, the word "skip" in a sentence included.
      const said = "The plumber moved Thursday's visit to Friday at 9. Bo, can you be home, or should we skip this week?";
      const worth = await chat.tag("ada", look, [looked, { text: said }], [], checkIn);
      assert.equal(worth.answer, said, "a check-in with news texts it whole");
      assert.notEqual(worth.body.quiet, true);

      // A person's own text is never read this way: an answer that uses the word is theirs.
      const person = await chat.tag("ada", "Tex what should I tap to pass the intro?", "Tap SKIP in the top corner to pass the intro.", [], { tagged: true, group: { people: ["ada"], cause: "tagged" } });
      assert.equal(person.answer, "Tap SKIP in the top corner to pass the intro.");
      assert.notEqual(person.body.quiet, true);
    } finally {
      chat.restore();
    }
  },
};
