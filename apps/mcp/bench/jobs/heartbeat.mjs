/**
 * THE CHECK-IN'S CHECK: TEX'S HEARTBEAT, AS PRODUCTION RUNS IT.
 *
 * A throwaway world (`world.mjs`) whose person holds a check-in grant, with the
 * setup under test written where production reads it
 * (`ai/production/heartbeat.md` in the pinned `@context-lc`) and the case's
 * notes placed in their workspace, so they read as changed since the last look.
 * One `/agent` check-in call, through the real `heartbeat.js`, its read-only
 * guard and its own SKIP rule. The output checked is the text it would send,
 * or `SKIP` when it stayed quiet, so a case says "stay quiet" as
 * `must include: SKIP` and "text them" as `must not include: SKIP`.
 */

import { PRODUCTION_HEARTBEAT_PATH } from "../../src/agent/production.js";
import { anthropicGateway, claudeTransport, fakeAi, workersAi } from "../models.mjs";
import { createWorld } from "../world.mjs";

/** The world needs a texting setup note too; no word of it reaches a check-in. */
const PLAIN_TEXTING_SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * A scripted model for `--fake`: reads the first changed note it is shown,
 * then texts its first line back. Proves the plumbing, never the judgement.
 */
export function fakeHeartbeatGateway() {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1);
    const result = Array.isArray(last?.content) ? last.content.find((block) => block.type === "tool_result") : null;
    const usage = { input_tokens: 1000, output_tokens: 30 };
    if (!result) {
      const asked = JSON.stringify(body.messages);
      const path = /- ([^\s"\\]+\.md) \(/.exec(asked)?.[1];
      if (!path) return json({ content: [{ type: "text", text: "SKIP" }], stop_reason: "end_turn", usage });
      return json({ content: [{ type: "tool_use", id: "toolu_read", name: "read_note", input: { path } }], stop_reason: "tool_use", usage });
    }
    const text = typeof result.content === "string" ? result.content : (result.content ?? []).map((block) => block.text ?? "").join("\n");
    const line = text.split("\n").find((candidate) => candidate.startsWith("# ")) ?? "SKIP";
    return json({ content: [{ type: "text", text: `Saw ${line.slice(2)}.` }], stop_reason: "end_turn", usage });
  };
}

export const heartbeatJob = {
  name: "heartbeat",
  setupNote: true,
  async run({ bench, setup, testCase, today, fake }) {
    if (!testCase.as) throw new Error(`case ${testCase.n}: no person to check in on (run_as or - as:)`);
    const models = {
      gatewayFetch: fake ? fakeHeartbeatGateway() : anthropicGateway(claudeTransport(process.env)),
      ai: fake ? fakeAi() : workersAi(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_AI_TOKEN, process.env.AI_GATEWAY_ID ?? null),
      clientId: "context_heartbeat",
      pinnedNotes: [{ path: PRODUCTION_HEARTBEAT_PATH, raw: setup.raw }],
    };
    const world = await createWorld(bench, testCase.as, PLAIN_TEXTING_SETUP, models, today);
    try {
      for (const note of testCase.notes) world.place(note.path, note.body);
      // The last look was a day ago: everything the case placed reads as changed since.
      const answer = await world.agent({ heartbeat: { timeZone: "UTC", since: null } });
      const outcome = answer.body?.outcome ?? answer.body?.error ?? `status ${answer.status}`;
      if (answer.status !== 200) return { output: "", error: String(outcome), ms: answer.ms, model: answer.model };
      const output = outcome === "speak" ? String(answer.body.answer ?? "") : "SKIP";
      return { output, error: null, ms: answer.ms, model: answer.model };
    } finally {
      world.close();
    }
  },
};
