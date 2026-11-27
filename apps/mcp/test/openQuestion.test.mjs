/**
 * TEX'S OWN OPEN QUESTION, AS A FACT (Dev2, 2026-11-27; `openQuestion.js`, launch-day rehearsal finding 5a).
 *
 * Tex asked "What area should I search?", the answer came ("poconos! driving distance from nyc"), and the turn read it
 * as a new question. The turn now gets Tex's newest question as data. People and words are invented.
 *
 * Sabotage record (2026-11-27), each applied, this file run, named test failing, reverted:
 *  1. `openQuestionFact` without the `event.at < first` check → "a question Tex asked after the texts is not theirs" fails.
 *  2. `openQuestionFact` without the day limit → "a question from days ago is history" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { askedIn, openQuestionFact, OPEN_FOR_MS } from "../../../packages/tex/gateway/agent/openQuestion.js";

const at = (minutes) => 1_800_000_000_000 + minutes * 60_000;
const tex = (minutes, text, extra = {}) => ({ id: `t${minutes}`, at: at(minutes), kind: "text", from: { kind: "tex" }, text, ...extra });
const person = (minutes, text) => ({ id: `p${minutes}`, at: at(minutes), kind: "text", from: { kind: "person", name: "guest-1a2b" }, text });

test("the newest text Tex sent before the ones it answers, when it asks something, is the turn's open question", () => {
  const answer = person(3, "poconos! driving distance from nyc");
  const shown = [person(0, "Tex find us a cabin"), tex(1, "On it. What area should I search?"), answer];
  assert.equal(openQuestionFact(shown, [answer]), JSON.stringify({ your_open_question: "What area should I search?" }));
});

test("no fact when Tex's newest text asks nothing, or nothing is being answered", () => {
  const answer = person(3, "cool");
  assert.equal(openQuestionFact([tex(1, "Found three cabins."), answer], [answer]), "");
  assert.equal(openQuestionFact([tex(1, "Which one?")], []), "");
});

test("a question Tex asked after the texts is not theirs, and one that never went out is none", () => {
  const answer = person(3, "poconos");
  assert.equal(openQuestionFact([answer, tex(4, "Which area?")], [answer]), "");
  assert.equal(openQuestionFact([tex(1, "Which area?", { delivered: false }), answer], [answer]), "");
});

test("a question from days ago is history", () => {
  const answer = person(3 + OPEN_FOR_MS / 60_000 + 1, "poconos");
  assert.equal(openQuestionFact([tex(1, "Which area?"), answer], [answer]), "");
});

test("only the sentences that ask are kept", () => {
  assert.equal(askedIn("Found 3 cabins. Want the cheapest? Or the closest?"), "Want the cheapest? Or the closest?");
  assert.equal(askedIn("Done."), "");
});
