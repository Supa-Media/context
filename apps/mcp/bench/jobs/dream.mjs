/**
 * THE DREAM'S CHECK: TEX'S NIGHTLY DREAM, AS PRODUCTION RUNS IT.
 *
 * A throwaway world (`world.mjs`) whose person holds a dreams grant, with the
 * setup under test written where production reads it
 * (`ai/production/dream.md` in the pinned `@context-lc`) and the case's notes
 * (a day's transcript, an about-me) in their workspace. One `/agent` dream
 * call, through the real `dream.js`, its tools and its one-note guard; the
 * output checked is `tex/about.md` afterwards.
 */

import { ABOUT_ME_PATH } from "../../src/agent/aboutMe.js";
import { PRODUCTION_DREAM_PATH } from "../../src/agent/production.js";
import { anthropicGateway, claudeTransport, fakeAi, workersAi } from "../models.mjs";
import { createWorld } from "../world.mjs";

/** The world needs a texting setup note too; no word of it reaches a dream. */
const PLAIN_TEXTING_SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * A scripted model for `--fake`: reads the first transcript the dream names,
 * then writes its "Them" lines into the note. Proves the plumbing, never the words.
 */
export function fakeDreamGateway() {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1);
    const result = Array.isArray(last?.content) ? last.content.find((block) => block.type === "tool_result") : null;
    const usage = { input_tokens: 1000, output_tokens: 40 };
    if (!result) {
      const asked = JSON.stringify(body.messages);
      const path = /tex\/transcripts\/[\d-]+\.md/.exec(asked)?.[0] ?? ABOUT_ME_PATH;
      return json({ content: [{ type: "tool_use", id: "toolu_read", name: "read_note", input: { path } }], stop_reason: "tool_use", usage });
    }
    const text = typeof result.content === "string" ? result.content : (result.content ?? []).map((block) => block.text ?? "").join("\n");
    if (body.messages.filter((message) => message.role === "assistant").length >= 2) {
      return json({ content: [{ type: "text", text: "Wrote what they said." }], stop_reason: "end_turn", usage });
    }
    const said = text.split("\n").filter((line) => line.includes("Them:")).map((line) => `- ${line.replace(/\*\*Them:\*\*\s*/, "")}`);
    const content = `# About them\n\n${said.join("\n") || "- Nothing yet"}\n`;
    return json({
      content: [{ type: "tool_use", id: "toolu_write", name: "write_note", input: { path: ABOUT_ME_PATH, content } }],
      stop_reason: "tool_use",
      usage,
    });
  };
}

export const dreamJob = {
  name: "dream",
  setupNote: true,
  async run({ bench, setup, testCase, today, fake }) {
    if (!testCase.as) throw new Error(`case ${testCase.n}: no person to dream about (run_as or - as:)`);
    const models = {
      gatewayFetch: fake ? fakeDreamGateway() : anthropicGateway(claudeTransport(process.env)),
      ai: fake ? fakeAi() : workersAi(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_AI_TOKEN, process.env.AI_GATEWAY_ID ?? null),
      clientId: "context_dreams",
      pinnedNotes: [{ path: PRODUCTION_DREAM_PATH, raw: setup.raw }],
    };
    const world = await createWorld(bench, testCase.as, PLAIN_TEXTING_SETUP, models, today);
    try {
      for (const note of testCase.notes) world.place(note.path, note.body);
      const answer = await world.agent({ dream: { timeZone: "UTC", since: null } });
      const outcome = answer.body?.outcome ?? answer.body?.error ?? `status ${answer.status}`;
      if (answer.status !== 200) return { output: "", error: String(outcome), ms: answer.ms, model: answer.model };
      return { output: world.read(ABOUT_ME_PATH) ?? "", error: null, ms: answer.ms, model: answer.model };
    } finally {
      world.close();
    }
  },
};
