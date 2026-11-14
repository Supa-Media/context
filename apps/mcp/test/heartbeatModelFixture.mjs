/** A scripted Anthropic-shaped model for the check-in tests (`agentHeartbeat.test.mjs`): each reply in turn, every request kept. */
export function fakeModel() {
  const requests = [];
  let script = [];
  return {
    requests,
    install(replies) {
      script = [...replies];
    },
    async handle(_url, init) {
      requests.push(JSON.parse(init.body));
      const step = script.shift();
      if (!step) throw new Error("fake model: the script ran out");
      const next = typeof step === "function" ? step(JSON.stringify(requests.at(-1))) : step;
      const content = [];
      if (next.thinking) content.push({ type: "thinking", thinking: next.thinking, signature: "sig" });
      if (next.text) content.push({ type: "text", text: next.text });
      for (const [i, call] of (next.toolCalls ?? []).entries()) {
        content.push({ type: "tool_use", id: `toolu_${i}`, name: call.name, input: call.args ?? {} });
      }
      return new Response(
        JSON.stringify({ content, stop_reason: (next.toolCalls ?? []).length > 0 ? "tool_use" : "end_turn" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  };
}
