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

const ALERT = {
  address: "ada@example.invalid",
  id: "alert-1",
  date: "Fri, 27 Nov 2026 22:32:00 +0000",
  from: "Example Social <alerts@example.invalid>",
  to: "ada@example.invalid",
  subject: "New login to your account",
  snippet: "We noticed a login from a new device: a Linux browser. Was this you?",
};

const FOUND = "- [today] New login alert for Ada's account from a Linux browser · their email, 5:32 pm · no offer; ask whether it was them";
const TAGGED = "[check-in] Example Social sent a new-login alert at 5:32 pm, from a Linux browser. Was that you? If not, change the password.";
const PLAIN = "Example Social sent a new-login alert at 5:32 pm, from a Linux browser. Was that you? If not, change the password.";

export default {
  id: "checkin-runs-the-graph",
  incident: "2026-11-22: a Lab test chat's check-in showed \"answer check logged no run\": the check-in's draft was checked inside the look's own model loop, as code beside the graph. After that fix, a quiet look's say_nothing still logged no Tools run. 2026-11-27 6:01 PM ET: a real 1:1 check-in went out as \"[check-in] Two things to check…\"; no code wrote the tag, and the claim checks let it go.",
  cause: "The check-in fired only the checkin -> fd wire and handed the reply judge's check straight to the model loop, so the Answer check and Text them never ran as config nodes and nothing logged them. On 11-27: the look was shown bracketed tags at the start of line after line (\"- [today] …\", \"[1] You (a check-in) …\") and told a \"[continues N]\" marker opening its answer is never shown; only that exact marker was taken off.",
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
      // 2026-11-27: a look that opens its text with a label is sent back once, and none is taught to it.
      chat.wait(60 * 60_000);
      const ran = await chat.checkIn([{ text: TAGGED }, { text: PLAIN }], { mail: [ALERT], research: [{ text: FOUND }] });
      assert.match(ran.shown, /- today · New login alert/, "the look reads the finding's urgency as a plain field");
      assert.doesNotMatch(ran.shown, /- \[today\]|\[continues N\]/, "never a bracketed tag at the start of a line, nor a marker it is told is hidden");
      assert.match(ran.shown, /line_opens_with\W+\[check-in\]/, "the tagged draft went back with what it opens with, as a fact");
      assert.equal(ran.answer, PLAIN, "what reaches them opens with the news, not a label");
    } finally {
      chat.restore();
    }
  },
};
