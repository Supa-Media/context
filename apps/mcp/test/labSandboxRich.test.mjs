// A made-up chat's native tags, effects and other apps' cards (packages/lab/gateway/labSandbox/rich.js; Dev,
// 2026-11-23): each is turned into what Photon's bridge hands the Worker and read into Tex's words by the Worker's
// own code (`packages/tex/worker/photonRich.ts`), as a real text is. Fake names and words.
//
// Sabotage (temporary local edits, reverted, 2026-11-24):
//   photonRich.ts `taggedWords` returning the words as given   "a tag reads as @name" fails
//   rich.js leaving `app` off the message                     "another app's card reads as its words" fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { richText } from "../../../packages/lab/gateway/labSandbox/rich.js";

test("a text with none of the three is the words as typed", async () => {
  assert.deepEqual(await richText({ text: "Tex hi" }), { text: "Tex hi" });
});

test("a tag reads as @name, at the name's first untagged place, and the row keeps what was typed", async () => {
  const read = await richText({ text: "Tex ask Sam and Sam", tags: ["Tex", "Sam", "@Sam"] });
  assert.equal(read.text, "@Tex ask @Sam and @Sam");
  assert.deepEqual(read.rich, { tags: [{ start: 0, length: 3 }, { start: 8, length: 3 }, { start: 16, length: 3 }], typed: "Tex ask Sam and Sam" });
  assert.match((await richText({ text: "hi", tags: ["Tex"] })).error, /not in the text/);
  assert.match((await richText({ text: "hi", tags: "Tex" })).error, /tags is a list/);
});

test("an effect is named as Messages names it, and goes only on words", async () => {
  assert.equal((await richText({ text: "WE WON", effect: "slam" })).text, "(sent with Slam) WE WON");
  assert.equal((await richText({ text: "shh", effect: "Invisible Ink" })).rich.effect, "Invisible Ink");
  assert.match((await richText({ text: "x", effect: "Wobble" })).error, /effect is one of/);
});

test("another app's card reads as its words", async () => {
  const read = await richText({ text: "", app: { app: "Apple Cash", caption: "$40", subcaption: "Sent" } });
  assert.equal(read.text, "(Apple Cash card: $40 · Sent)");
  assert.deepEqual(read.rich.app, { app: "Apple Cash", caption: "$40", subcaption: "Sent" });
  assert.equal((await richText({ text: "for dinner", app: { app: "Check In", summary: "Sam arrived home" } })).text, "(Check In card: Sam arrived home) for dinner");
  assert.match((await richText({ text: "", app: { app: "Apple Cash" } })).error, /needs words/);
});
