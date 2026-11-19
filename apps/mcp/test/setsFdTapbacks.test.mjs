import { test } from "node:test";
import assert from "node:assert/strict";
import { earlierLines, personTapbackLine } from "../bench/setsFd.mjs";
import { reactionLine } from "../../agent/src/gatewayInbound.js";

// A person's tapback is a line of the chat, as production logs it (`reactionLine`), and names the message it was on:
// a 👍 on somebody else's text and a ❤️ on Tex's, with their handles in a group. Sabotage: drop the person branch in
// `earlierLines` (the `kind` skip) and the two tapback lines go missing.
test("a person's tapback is an earlier line with production's text and who said it", () => {
  const c = {
    kind: "group",
    msgs: [
      { id: "m1", who: "Ana", text: "nah just tapback it" },
      { id: "m2", who: "Tex", tex: true, text: "Want me to book it?" },
      { id: "m3", who: "Ben", kind: "react", to: "m1", text: "👍" },
      { id: "m4", who: "Ana", kind: "react", to: "m2", text: "❤️" },
      { id: "m5", who: "Ana", text: "ok" },
    ],
  };
  assert.deepEqual(earlierLines(c, 4), [
    { from: "person", who: "ana", text: "nah just tapback it" },
    { from: "tex", text: "Want me to book it?" },
    { from: "person", who: "ben", text: '👍 (yes) on the message "nah just tapback it"' },
    { from: "person", who: "ana", text: "❤️ (yes) on Tex's message \"Want me to book it?\"" },
  ]);
});

// The one-line texts of `personTapbackLine` are reactionLine's, word for word (`apps/agent/src/reactions.ts`): the bench
// writes the chat the Worker logs. Sabotage: change the answer suffix or the 120-character cut in one of them.
test("personTapbackLine reads exactly as production's reactionLine does", () => {
  const msg = (id, who, text, extra = {}) => ({ id, who, text, ...extra });
  const long = "word ".repeat(40);
  const cases = [
    { emoji: "👍", onTex: false, text: "see you at six" },
    { emoji: "👎", onTex: false, text: "pizza or tacos" },
    { emoji: "❤️", onTex: true, text: "Want me to book it?" },
    { emoji: "😂", onTex: false, text: "lol" },
    { emoji: "👍", onTex: false, text: long },
  ];
  for (const { emoji, onTex, text } of cases) {
    const c = { kind: "group", msgs: [msg("t", onTex ? "Tex" : "Ana", text, onTex ? { tex: true } : {}), msg("r", "Ben", emoji, { kind: "react", to: "t" })] };
    const how = { "👍": "Liked", "👎": "Disliked", "❤️": "Loved", "😂": "Laughed at" }[emoji];
    const words = onTex ? text : "";
    const expected = reactionLine({ how, words, onOther: !onTex || undefined, otherWords: onTex ? undefined : text }, onTex);
    assert.equal(personTapbackLine(c, c.msgs[1]), expected, emoji);
  }
});
