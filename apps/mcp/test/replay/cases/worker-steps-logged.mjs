import assert from "node:assert/strict";
import { request, TOKEN_TEXTS } from "../../agentEgressFixtures.mjs";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

const LINE = "sendblue:line:+15555550100";

export default {
  id: "worker-steps-logged",
  incident: "2026-11-13: after every gateway step was logged (#3265), a person's own chat's judging and every tapback Tex sent still left nothing in the chat's record, so a tapback where an answer was owed could not be traced from the chat.",
  cause: "Both run in the texting Worker, which posted only the chat's lines to the ledger.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("can you move my dentist to friday?", "Done, Friday at 10.");
      // The Worker's judging of a "thanks" and the tapback it chose, posted as it posts them (`apps/agent/src/stepEvents.ts`).
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
    } finally {
      chat.restore();
    }
  },
};
