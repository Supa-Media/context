import assert from "node:assert/strict";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

export default {
  id: "door-settings-logged",
  incident: "2026-11-14: reviewing a turn in the Lab's Replay, Door steps showed nothing it got or gave and no setting the turn ran with, so which model, effort, reviewer or advisor a turn used could not be read from the chat's record.",
  cause: "Door steps logged only how long each part of its gathering took; the settings it handed the front door were never written down.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("what's on my list for saturday?", "Groceries and the bike shop.");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { entries } = await ledgerFor(chat.world.env, { person: "ws_egress" }).read(ONE_TO_ONE_CHAT);
      const door = entries.find((entry) => entry.kind === "step" && entry.step === "door");
      assert.ok(door, "Door steps is a step in the chat's record");
      const reply = entries.find((entry) => entry.kind === "reply");
      assert.equal(door.turn, reply.turn, "under the turn it set up");
      assert.equal(door.input.chat, "one", "with the kind of chat it was");
      for (const setting of ["model", "effort", "reviewer", "advisor", "planner", "fallback"]) assert.ok(setting in door.output, `and the ${setting} the turn ran with`);
      assert.ok(!JSON.stringify(door).includes("bike shop") && !JSON.stringify(door).includes("saturday"), "never the chat's words, which are its text entries");
    } finally {
      chat.restore();
    }
  },
};
