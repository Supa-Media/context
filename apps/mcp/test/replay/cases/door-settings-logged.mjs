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
      // Since the turn runs on the config's graph (2026-11-14), each door step is a node the runner logs, and the settings are the front door node's.
      const door = entries.find((entry) => entry.kind === "step" && entry.step === "node" && entry.name === "readTheText");
      assert.ok(door, "the first door step is a node in the chat's record");
      const fd = entries.find((entry) => entry.kind === "step" && entry.step === "node" && entry.name === "fd" && entry.via === "wait");
      assert.ok(fd, "and so is the front door, which says what it ran with");
      const ran = entries.filter((entry) => entry.kind === "step" && entry.step === "node" && entry.via === "wait").map((entry) => entry.name);
      assert.deepEqual(ran.slice(0, 13), ["readTheText", "runARoutine", "checkTheQuestion", "settleAYesOrNo", "watchWhatLeaves", "checkItMayRun", "readTheHistory", "openTheWeb", "readTheSetup", "prepareBookkeeping", "prepareTheAnswer", "fd", "checks"], "the door's eleven nodes, then the front door and its checks, as the config's wires run them");
      assert.ok(ran.includes("send"), "and Text them");
      const reply = entries.find((entry) => entry.kind === "reply");
      assert.equal(door.turn, reply.turn, "under the turn it set up");
      assert.equal(fd.turn, reply.turn, "the front door's too");
      assert.equal(door.output.chat, "one", "with the kind of chat it was");
      for (const setting of ["model", "effort", "reviewer", "advisor", "planner", "fallback"]) assert.ok(setting in fd.output, `and the ${setting} the turn ran with`);
      const nodes = JSON.stringify(entries.filter((entry) => entry.kind === "step" && entry.step === "node")); // a tool's arguments and result are its tool entry, kept by that entry's rules
      assert.ok(!nodes.includes("bike shop") && !nodes.includes("saturday"), "never the chat's words, which are its text entries");
    } finally {
      chat.restore();
    }
  },
};
