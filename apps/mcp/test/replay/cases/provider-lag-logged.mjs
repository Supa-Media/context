import assert from "node:assert/strict";
import { request, TOKEN_TEXTS } from "../../agentEgressFixtures.mjs";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

const LINE = "sendblue:line:+15555550100";

export default {
  id: "provider-lag-logged",
  incident: "2026-11-14: in a test chat a text took about two minutes from the phone to the provider's webhook, and the provider's own \"sent\" took 15 to 333 seconds, and no step of the chat showed either, so a slow reply could not be told from a slow Tex.",
  cause: "The texting Worker dropped the provider's own times for a text and a send; only our own clock was logged.",
  path: "1:1 text",
  // Sabotage (2026-11-14): drop "text" and "send" from log.js WORKER_STEPS and this case fails.
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("can you move my dentist to friday?", "Done, Friday at 10.");
      const ledger = ledgerFor(chat.world.env, { person: "ws_egress" });
      const at = Math.max(...(await ledger.read(ONE_TO_ONE_CHAT, { kinds: ["text"] })).entries.map((entry) => entry.at)) + 10_000;
      // The chat's text and send steps, as the Worker posts them (`apps/agent/src/stepEvents.ts` textStep, sendStep).
      const provider = { name: "sendblue", providerAt: at - 120_000, receivedAt: at, lagMs: 120_000 };
      const arrived = { id: `${at}-910001`, at, chat: LINE, from: { kind: "system" }, kind: "step", step: { name: "text", of: "one", ok: true, ms: 120_000, input: { provider }, output: { outcome: "queued", queuedAt: at, lagMs: 120_000 } } };
      const sent = { id: `${at + 1}-910002`, at: at + 1, chat: LINE, from: { kind: "system" }, kind: "step", step: { name: "send", of: "failed", ok: false, ms: 333_000, input: { provider: "sendblue", handle: "mh-fake-1" }, output: { status: "failed", error: { code: "4001" } }, cause: "4001" } };
      const posted = await request(chat.world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [arrived, sent] });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
      assert.deepEqual(posted.body.written, [arrived.id, sent.id], "both are taken, so the Worker forgets them");
      chat.deploy();
      const next = await chat.text("what time is it again?", "10am Friday.");
      assert.doesNotMatch(next.shown, /lagMs|providerAt|4001/, "a provider's times never reach what a turn reads");
      const steps = (await ledger.read(ONE_TO_ONE_CHAT)).entries.filter((entry) => entry.kind === "step" && (entry.step === "text" || entry.step === "send"));
      assert.deepEqual(steps.map((entry) => [entry.step, entry.ok, entry.ms]), [["text", true, 120_000], ["send", false, 333_000]], "the lag on each is in the chat's record");
      assert.equal(steps[0].input.provider.lagMs, 120_000);
      assert.equal(steps[1].reason, "4001", "with the provider's error");
    } finally {
      chat.restore();
    }
  },
};
