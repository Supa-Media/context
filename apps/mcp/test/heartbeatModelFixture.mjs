import { RESEARCH_ASK } from "../../../packages/tex/gateway/agent/graph/nodes/checkinResearch.js";
import { asSixCall } from "./sixCallFixture.mjs";

const RESEARCH_MARK = RESEARCH_ASK.split("\n")[0];

/**
 * A scripted Anthropic-shaped model for the check-in tests (`agentHeartbeat.test.mjs`): each reply in turn, every request
 * kept. The check-in's Research step (wired ahead of the look since 2026-11-22) finds nothing here, outside the script:
 * its requests are kept apart in `researched`, so `requests` and the script stay the look's own.
 */
export function fakeModel() {
  const requests = [];
  const researched = [];
  let script = [];
  return {
    requests,
    researched,
    install(replies) {
      script = [...replies];
    },
    async handle(_url, init) {
      if (String(init.body).includes(JSON.stringify(RESEARCH_MARK).slice(1, -1))) {
        researched.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ content: [{ type: "text", text: "- nothing" }], stop_reason: "end_turn" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      requests.push(JSON.parse(init.body));
      const step = script.shift();
      if (!step) throw new Error("fake model: the script ran out");
      const next = typeof step === "function" ? step(JSON.stringify(requests.at(-1))) : step;
      const content = [];
      if (next.thinking) content.push({ type: "thinking", thinking: next.thinking, signature: "sig" });
      if (next.text) content.push({ type: "text", text: next.text });
      for (const [i, call] of (next.toolCalls ?? []).map(asSixCall).entries()) {
        content.push({ type: "tool_use", id: `toolu_${i}`, name: call.name, input: call.args ?? {} });
      }
      return new Response(
        JSON.stringify({ content, stop_reason: (next.toolCalls ?? []).length > 0 ? "tool_use" : "end_turn" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  };
}
