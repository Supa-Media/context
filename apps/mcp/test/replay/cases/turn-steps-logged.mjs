import assert from "node:assert/strict";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

export default {
  id: "turn-steps-logged",
  incident: "2026-11-13: of the turn's 23 steps, 10 left nothing in the chat's record (the router, the fallback, the front door's own steps, the card check, the classifier, the self-review and more), so a bad answer could not be traced or replayed from the chat alone.",
  cause: "Only the model's thinking, its words, its tool calls, the judges and the reply were written to the chat's ledger; every other step logged to the console or nowhere.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("what's on my list for saturday?", "Groceries and the bike shop.");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { entries } = await ledgerFor(chat.world.env, { person: "ws_egress" }).read(ONE_TO_ONE_CHAT);
      const steps = entries.filter((entry) => entry.kind === "step");
      const model = steps.find((entry) => entry.step === "timing" && entry.name === "model");
      assert.ok(model, "the model's step is in the chat's record");
      assert.ok(Number.isFinite(model.ms) && model.ok === true, "with its time and outcome");
      assert.ok(typeof model.turn === "string" && model.turn !== "", "under its turn");
      const reply = entries.find((entry) => entry.kind === "reply");
      assert.equal(model.turn, reply.turn, "the same turn as the reply it led to");
      assert.ok(steps.filter((entry) => entry.step === "timing").length >= 5, "and the front door's steps beside it");
    } finally {
      chat.restore();
    }
  },
};
