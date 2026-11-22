import assert from "node:assert/strict";
import { ONE_TO_ONE_CHAT, ledgerFor } from "../../../../../packages/tex/gateway/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

const PERMIT = {
  address: "ada@example.invalid",
  id: "permit-2",
  date: "Wed, 18 Nov 2026 15:00:00 +0000",
  from: "Harbor office <harbor@example.invalid>",
  to: "ada@example.invalid",
  subject: "Slip 12 approved",
  snippet: "Approved. The note does not say which dock or which weekend.",
};
const SAID = "Slip 12 is approved, and the email never says which dock or which weekend. Want me to ask the harbor office?";

export default {
  id: "checkin-runs-the-graph",
  incident: "2026-11-22: a Lab test chat's check-in showed \"answer check logged no run\": the check-in's draft was checked inside the look's own model loop, as code beside the graph. After that fix, a quiet look's say_nothing still logged no Tools run.",
  cause: "The check-in fired only the checkin -> fd wire and handed the reply judge's check straight to the model loop, so the Answer check and Text them never ran as config nodes and nothing logged them.",
  path: "1:1 check-in",
  async run() {
    const chat = await oneToOne();
    try {
      const check = await chat.checkIn([{ text: SAID }], { mail: [PERMIT] });
      assert.equal(check.answer, SAID, "the check-in texts what the look wrote");
      const entries = (await ledgerFor(chat.world.env, { person: "ws_egress" }).read(ONE_TO_ONE_CHAT)).entries;
      const nodes = entries.filter((entry) => entry.kind === "step" && entry.step === "node" && entry.turn === check.turn).map((entry) => entry.name);
      for (const node of ["checkin", "fd", "answerCheck", "send"]) assert.ok(nodes.includes(node), `${node} ran as a node of the check-in's run (ran: ${nodes.join(", ")})`);
      assert.ok(nodes.indexOf("answerCheck") > nodes.indexOf("fd") && nodes.indexOf("send") > nodes.indexOf("answerCheck"), "in the config's order: the look, its check, then Text them");
      // A look that stays quiet: its say_nothing, which the model loop adds itself, is a Tools run too (2026-11-22).
      chat.wait(60 * 60_000);
      const quiet = await chat.checkIn([{ toolCalls: [{ name: "say_nothing", args: { why: "nothing new" } }] }, { toolCalls: [{ name: "verdict", args: { speak: false, why: "nothing needs them" } }] }], { mail: [PERMIT] });
      assert.equal(quiet.answer, "", "the quiet look texts nothing");
      const after = (await ledgerFor(chat.world.env, { person: "ws_egress" }).read(ONE_TO_ONE_CHAT)).entries;
      const tools = after.filter((entry) => entry.kind === "step" && entry.step === "node" && entry.name === "tools");
      assert.ok(tools.some((entry) => entry.input?.name === "say_nothing"), `say_nothing ran as the Tools node (tools runs: ${JSON.stringify(tools.map((entry) => entry.input))})`);
    } finally {
      chat.restore();
    }
  },
};
