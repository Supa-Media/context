import assert from "node:assert/strict";
import { request, TOKEN_TEXTS } from "../../agentEgressFixtures.mjs";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

const LINE = "photon:+15555550199:+15555550100";

export default {
  id: "link-preview-in-one-to-one",
  incident: "2026-11-16: on Photon's line a person texted Tex \"what's this link\" and then a link, which iMessage sent with its rich preview; Tex answered that it saw no link. The same two texts in a group chat were answered from the page.",
  cause: "The texting Worker's Photon reader dropped any 1:1 message carrying an app card id that was not Tex's own (`apps/agent/src/photonInbound.ts`); Apple's link preview carries one, so the link never reached the chat. Groups never checked the id. The drop reached only the Worker's logs, so the chat's record showed nothing.",
  path: "1:1 text",
  // Sabotage (2026-11-17): in photonInbound.ts drop `&& !isLinkPreview(...)` and the Worker's own tests fail
  // (photonInbound.test.ts, photonEvents.test.ts); here, a text step's "dropped" outcome refused by the ledger fails it.
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("what's this link", "Send it over and I'll take a look.");
      // The link, as the Worker now hands it over: the preview's words, a plain text.
      const link = await chat.text("https://shop.example/products/hoodie", "It's a black hoodie, $95.");
      assert.match(link.shown, /https:\/\/shop\.example\/products\/hoodie/, "the turn is shown the link the preview stood for");
      // A message the line still drops (another app's card) is the chat's text step, outcome "dropped" and why, as the
      // Worker posts it (`stepEvents.ts` logDropped): never its words.
      const ledger = ledgerFor(chat.world.env, { person: "ws_egress" });
      const at = Math.max(...(await ledger.read(ONE_TO_ONE_CHAT, { kinds: ["text"] })).entries.map((entry) => entry.at)) + 10_000;
      const provider = { name: "photon", providerAt: at - 200, receivedAt: at, lagMs: 200 };
      const dropped = { id: `${at}-920001`, at, chat: LINE, from: { kind: "system" }, kind: "step", step: { name: "text", of: "one", ok: false, ms: 200, input: { provider }, output: { outcome: "dropped", reason: "app_card", queuedAt: at, lagMs: 200 }, cause: "app_card" } };
      const posted = await request(chat.world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [dropped] });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
      assert.deepEqual(posted.body.written, [dropped.id], "the drop is taken into the chat's record");
      const steps = (await ledger.read(ONE_TO_ONE_CHAT)).entries.filter((entry) => entry.kind === "step" && entry.step === "text" && entry.output?.outcome === "dropped");
      assert.equal(steps.length, 1, "Replay can show the drop");
      assert.equal(steps[0].output.reason, "app_card", "and why");
      assert.equal(steps[0].ok, false);
      chat.deploy();
      const next = await chat.text("did you get it?", "Yes.");
      assert.doesNotMatch(next.shown, /app_card|dropped/, "a drop's step never reaches what a turn reads");
    } finally {
      chat.restore();
    }
  },
};
