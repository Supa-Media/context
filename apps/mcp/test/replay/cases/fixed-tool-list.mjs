import assert from "node:assert/strict";
import { TEX_CONFIG } from "../../../src/agent/texConfig.js";
import { oneToOne } from "../chats.mjs";

const MAIL = {
  address: "ada@example.invalid",
  id: "fixed-1",
  date: "Wed, 18 Nov 2026 15:00:00 +0000",
  from: "Kiln <kiln@example.invalid>",
  to: "ada@example.invalid",
  subject: "15% off this weekend",
  snippet: "A newsletter: glazes are 15% off.",
};

const strip = (value) => JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));
const toolsOf = (requests) => requests.find((request) => Array.isArray(request.tools) && request.tools.length > 0)?.tools;
const said = (requests) => JSON.stringify(requests.map((request) => request.messages));

export default {
  id: "fixed-tool-list",
  incident:
    "2026-11-20: production showed Tex 61 different tool lists in 253 model calls, send alone in 47 forms and about 25,000 characters in a 1:1; 29% of tool failures were calls to a tool the turn didn't hold, and each change of list rewrote the prompt cache.",
  cause:
    "The six were described from what each turn held, with every action's whole guide pasted in. With the front door's toolList fixed, a 1:1's text and its check-in see the same six, an action's guide is fetch manual:<action>, and an action the turn doesn't hold is refused saying what is available.",
  path: "1:1 text and check-in, front door toolList fixed",
  // Sabotage (2026-11-20): heartbeat.js passing fixedTools: null fails "the check-in is shown what the text was".
  async run() {
    const steps = TEX_CONFIG.nodes.filter((node) => node.id === "fd" || node.id === "job");
    const before = steps.map((node) => node.toolList);
    for (const node of steps) node.toolList = "fixed";
    const chat = await oneToOne();
    try {
      const from = chat.world.model.requests.length;
      await chat.text("find me a dentist near the office", [{ toolCalls: [{ name: "fetch", args: { id: "manual:search_web" } }] }, { text: "On it." }]);
      const texted = chat.world.model.requests.slice(from);
      assert.match(said(texted), /send action search_web: /, "the manual came back as the call's answer");
      assert.match(said(texted), /Call: send \{ action: \\"search_web\\"/);
      chat.atNow();
      const looked = chat.world.model.requests.length;
      await chat.checkIn([{ toolCalls: [{ name: "send", args: { action: "search_web", args: { query: "dentist" } } }] }, { toolCalls: [{ name: "say_nothing", args: { why: "nothing new" } }] }], { mail: [MAIL] });
      const checked = chat.world.model.requests.slice(looked);
      assert.equal(strip(toolsOf(checked)), strip(toolsOf(texted)), "the check-in is shown what the text was, byte for byte");
      assert.match(said(checked), /isn't available on this turn/, "an action it doesn't hold is refused");
      assert.match(said(checked), /Available now: say_nothing/, "saying what it can do instead");
    } finally {
      chat.restore();
      steps.forEach((node, at) => (before[at] === undefined ? delete node.toolList : (node.toolList = before[at])));
    }
  },
};
