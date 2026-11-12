// The facts a reply keeps, through the real `/agent` route (`src/agent/toldFacts.js`; Dev2, 2026-11-12): a reply that
// read a page keeps its quote; a text more than an hour later, when the page is no longer carried, is shown the quote
// under the text it backs. Shown, it never marks that turn: a turn's trust is its own (turn-trust.md).
//
// Sabotage record (applied, run, observed failing, reverted, 2026-11-12):
//  1. `sendTheReply.js` not writing `factsEntry` → "keeps the quote".
//  2. `runTheModel.js` marking the turn shown a quote → "never marks it".
//  3. `loggedTurn.js` not passing `facts` to `renderEvents` → "shown the quote".
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, textTex, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { withAgentHome } from "./texStoreFixture.mjs";

let world;
const realNow = Date.now;
let offset = 0;
before(async () => {
  world = await createEgressWorld();
  Date.now = () => realNow() + offset;
});
after(() => {
  Date.now = realNow;
  world.restore();
});

const said = (request) => JSON.stringify(request?.messages ?? []);

test("a reply keeps the quote behind its claim; a text after the hour is shown it, and is not marked by it", async () => {
  offset = -(3 * 3_600_000);
  world.model.install([{ toolCalls: [{ name: "open_page", args: { url: "https://example.com/katz" } }] }, { text: "Katz's has a private room for up to 50, with set menus under $55 a person." }]);
  const first = await textTex(world.env, TOKEN_TEXTS, "where can 20 of us have dinner? https://example.com/katz");
  assert.equal(first.status, 200);
  const newest = () => withAgentHome(world.bucket, world.tex, "ws_egress").ledgerEntries().filter((entry) => entry.kind === "reply").sort((a, b) => b.at - a.at)[0];
  const kept = newest();
  assert.equal(kept.facts?.length, 1, "keeps the quote");
  assert.equal(kept.facts[0].source, "https://example.com/katz");
  assert.match(kept.facts[0].quote, /Capacity: 50\. Katz's, the Lower East Side deli/);

  offset += 2 * 3_600_000; // over an hour quiet: the page is no longer carried
  world.model.install([{ text: "Yes, the room for 50 still stands." }]);
  await textTex(world.env, TOKEN_TEXTS, "is the Katz's room still right?");
  const sent = said(world.model.requests.at(-1));
  assert.match(sent, /\(from https:\/\/example\.com\/katz: \\"[^"]*Capacity: 50/, "shown the quote");
  assert.ok(!sent.includes("tool_result"), "the page itself is not carried after the hour");
  assert.equal(newest().facts, undefined, "a reply that read nothing keeps no facts");
  assert.equal(newest().clean, true, "never marks it: the quote rides with the earlier answer, trusted as it is");
});
