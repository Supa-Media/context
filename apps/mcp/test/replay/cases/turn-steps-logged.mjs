import assert from "node:assert/strict";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

export default {
  id: "turn-steps-logged",
  incident: "2026-11-13: of the turn's 23 steps, 10 left nothing in the chat's record (the router, the fallback, the front door's own steps, the card check, the classifier, the self-review and more), and the Door showed no setting the turn ran with (2026-11-14), so a bad answer could not be traced or replayed from the chat alone.",
  cause: "Only the model's thinking, its words, its tool calls, the judges and the reply were written to the chat's ledger; every other step logged to the console or nowhere; the Door logged only how long its parts took, never the settings it handed the front door.",
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
      // Folded in from door-settings-logged (2026-11-14: the Door steps showed nothing they got or gave, and no setting the turn ran with).
      // Since the turn runs on the config's graph (2026-11-14), each door step is a node the runner logs, and the settings are the front door node's.
      const door = entries.find((entry) => entry.kind === "step" && entry.step === "node" && entry.name === "readTheText");
      assert.ok(door, "the first door step is a node in the chat's record");
      const fd = entries.find((entry) => entry.kind === "step" && entry.step === "node" && entry.name === "fd" && entry.via === "wait");
      assert.ok(fd, "and so is the front door, which says what it ran with");
      const ran = entries.filter((entry) => entry.kind === "step" && entry.step === "node" && entry.via === "wait").map((entry) => entry.name);
      assert.deepEqual(ran.slice(0, 13), ["readTheText", "runARoutine", "checkTheQuestion", "settleAYesOrNo", "watchWhatLeaves", "checkItMayRun", "readTheHistory", "openTheWeb", "readTheSetup", "prepareBookkeeping", "prepareTheAnswer", "fd", "checks"], "the door's eleven nodes, then the front door and its checks, as the config's wires run them");
      assert.ok(ran.includes("send"), "and Text them");
      assert.equal(door.turn, reply.turn, "under the turn it set up");
      assert.equal(fd.turn, reply.turn, "the front door's too");
      assert.equal(door.output.chat, "one", "with the kind of chat it was");
      for (const setting of ["model", "effort", "reviewer", "advisor", "planner", "fallback"]) assert.ok(setting in fd.output, `and the ${setting} the turn ran with`);
      const nodes = JSON.stringify(entries.filter((entry) => entry.kind === "step" && entry.step === "node" && !["reflect", "nudge"].includes(entry.name))); // a tool's arguments and result are its tool entry, kept by that entry's rules; Reflect and the nudge take the question as their input by design
      assert.ok(!nodes.includes("bike shop") && !nodes.includes("saturday"), "never the chat's words, which are its text entries");
    } finally {
      chat.restore();
    }
  },
};
