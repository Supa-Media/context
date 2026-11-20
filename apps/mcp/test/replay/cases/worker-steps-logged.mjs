import assert from "node:assert/strict";
import { request, TOKEN_TEXTS } from "../../agentEgressFixtures.mjs";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

const LINE = "sendblue:line:+15555550100";

export default {
  id: "worker-steps-logged",
  incident: "2026-11-13: after every gateway step was logged (#3265), a person's own chat's judging and every tapback Tex sent still left nothing in the chat's record, so a tapback where an answer was owed could not be traced from the chat. 2026-11-14: a text took about two minutes from the phone to the provider's webhook, and the provider's own \"sent\" took 15 to 333 seconds, and no step showed either.",
  cause: "Each runs in the texting Worker, which posted only the chat's lines to the ledger, and dropped the provider's own times for a text and a send.",
  path: "1:1 text",
  // Sabotage (2026-11-14, the provider times, merged here from provider-lag-logged 2026-11-16): drop "text" and "send"
  // from log.js WORKER_STEPS and this case fails.
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("can you move my dentist to friday?", "Done, Friday at 10.");
      // The Worker's judging of a "thanks" and the tapback it chose, posted as it posts them (`packages/tex/worker/stepEvents.ts`).
      // On the chat's own clock, after Tex's answer: the next turn reads only what came before its text.
      const ledger = ledgerFor(chat.world.env, { person: "ws_egress" });
      const at = Math.max(...(await ledger.read(ONE_TO_ONE_CHAT, { kinds: ["text"] })).entries.map((entry) => entry.at)) + 10_000;
      const thanks = { id: `${at}-900001`, at, chat: LINE, from: { kind: "person" }, kind: "text", text: "thanks!" };
      const judged = { id: `${at + 1}-900002`, at: at + 1, chat: LINE, from: { kind: "system" }, kind: "step", step: { name: "decide", of: "waiting", ok: true, ms: 640, input: { style: "direct", running: false, candidates: [thanks.id], newest: thanks.id, waitingAsks: 0, transcriptChars: 300 }, output: { act: "react", covers: [], stale: [], movedOn: false, confidence: 0.9, emoji: "🙏", why: "pure_ack" } } };
      const tapped = { id: `${at + 2}-900003`, at: at + 2, chat: LINE, from: { kind: "system" }, kind: "step", step: { name: "react", of: "decide", ok: true, ms: 120, input: { by: "decide", asked: "🙏", on: thanks.id }, output: { emoji: "🙏" } } };
      const posted = await request(chat.world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [thanks, judged, tapped] });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
      chat.deploy(); // the next turn reads its chat cold, from the ledger the steps were posted to
      const next = await chat.text("what time is it again?", "10am Friday.");
      assert.match(next.shown, /thanks!/, "the text the judge looked at is part of the chat the next turn reads");
      assert.doesNotMatch(next.shown, /pure_ack|transcriptChars|"react"/, "its steps never are");
      const { entries } = await ledger.read(ONE_TO_ONE_CHAT);
      const steps = entries.filter((entry) => entry.kind === "step" && (entry.step === "decide" || entry.step === "react"));
      assert.deepEqual(steps.map((entry) => [entry.step, entry.name, entry.ok]), [["decide", "waiting", true], ["react", "decide", true]], "both steps are in the chat's record");
      assert.equal(steps[0].output.act, "react", "with what the judge answered");
      assert.equal(steps[1].input.on, thanks.id, "and which text the tapback was on");
      // The chat's text and send steps with the provider's own times, as the Worker posts them (`stepEvents.ts` textStep, sendStep).
      const later = Math.max(...(await ledger.read(ONE_TO_ONE_CHAT, { kinds: ["text"] })).entries.map((entry) => entry.at)) + 10_000;
      const provider = { name: "sendblue", providerAt: later - 120_000, receivedAt: later, lagMs: 120_000 };
      const arrived = { id: `${later}-910001`, at: later, chat: LINE, from: { kind: "system" }, kind: "step", step: { name: "text", of: "one", ok: true, ms: 120_000, input: { provider }, output: { outcome: "queued", queuedAt: later, lagMs: 120_000 } } };
      const sent = { id: `${later + 1}-910002`, at: later + 1, chat: LINE, from: { kind: "system" }, kind: "step", step: { name: "send", of: "failed", ok: false, ms: 333_000, input: { provider: "sendblue", handle: "mh-fake-1" }, output: { status: "failed", error: { code: "4001" } }, cause: "4001" } };
      const timed = await request(chat.world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [arrived, sent] });
      assert.equal(timed.status, 200, JSON.stringify(timed.body));
      assert.deepEqual(timed.body.written, [arrived.id, sent.id], "both are taken, so the Worker forgets them");
      chat.deploy();
      const after = await chat.text("and the address?", "12 Main St.");
      assert.doesNotMatch(after.shown, /lagMs|providerAt|4001/, "a provider's times never reach what a turn reads");
      const timedSteps = (await ledger.read(ONE_TO_ONE_CHAT)).entries.filter((entry) => entry.kind === "step" && (entry.step === "text" || entry.step === "send"));
      assert.deepEqual(timedSteps.map((entry) => [entry.step, entry.ok, entry.ms]), [["text", true, 120_000], ["send", false, 333_000]], "the lag on each is in the chat's record");
      assert.equal(timedSteps[0].input.provider.lagMs, 120_000);
      assert.equal(timedSteps[1].reason, "4001", "with the provider's error");
      // 2026-11-16: on Photon's line a 1:1 link sent with its rich preview was dropped by the Worker as another app's
      // card, and only the Worker's logs knew; Tex answered that it saw no link. A message the line drops is now the
      // chat's text step, outcome "dropped" and why, never its words (`stepEvents.ts` logDropped).
      const dropAt = later + 20_000;
      const photon = { name: "photon", providerAt: dropAt - 200, receivedAt: dropAt, lagMs: 200 };
      const dropped = { id: `${dropAt}-910003`, at: dropAt, chat: LINE, from: { kind: "system" }, kind: "step", step: { name: "text", of: "one", ok: false, ms: 200, input: { provider: photon }, output: { outcome: "dropped", reason: "app_card", queuedAt: dropAt, lagMs: 200 }, cause: "app_card" } };
      const noted = await request(chat.world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [dropped] });
      assert.equal(noted.status, 200, JSON.stringify(noted.body));
      assert.deepEqual(noted.body.written, [dropped.id], "a drop is taken into the chat's record");
      const drops = (await ledger.read(ONE_TO_ONE_CHAT)).entries.filter((entry) => entry.kind === "step" && entry.step === "text" && entry.output?.outcome === "dropped");
      assert.deepEqual(drops.map((entry) => [entry.ok, entry.output.reason]), [[false, "app_card"]], "so Replay shows the drop and why");
      chat.deploy();
      const last = await chat.text("did you get the link?", "Yes.");
      assert.doesNotMatch(last.shown, /app_card|dropped/, "a drop's step never reaches what a turn reads");
    } finally {
      chat.restore();
    }
  },
};
