#!/usr/bin/env node
/**
 * `node bench/progressEval.mjs`: a few asks through the real texted prompt on a
 * real model, at each progress level (off, planOnly, normal), printing the
 * bubbles the chat would get in order. For the owner to read by eye; never run
 * in CI, and it spends: each ask is a few Claude calls.
 *
 * Needs the AI gateway the product uses (`src/agent/aiGateway.js`):
 *   AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, AI_GATEWAY_TOKEN, and ANTHROPIC_CREDIT_KEY
 *   when the gateway holds no key of its own.
 *   PROGRESS_EVAL_MODEL overrides the model (default: the product's gateway default).
 *
 * The web is scripted: open_page answers after a pause with a short page, so
 * the model meets a slow step without touching a real site.
 */

import { runTurn } from "../src/agent/turn.js";
import { BUILTIN_PROVIDER, DEFAULT_GATEWAY_MODEL } from "../src/agent/builtin.js";
import { progressChannel } from "../src/agent/progress.js";
import { aiGatewayConfig } from "../src/agent/aiGateway.js";

const ASKS = [
  "What's on my calendar tomorrow?",
  "Find me a table for four on Friday at 7 at Nopa or Zuni Cafe, and compare them.",
  "Look up the opening hours of the three nearest hardware stores and tell me which is open latest.",
];

const SEARCH = { name: "search_notes", description: "Search the person's notes.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } };
const OPEN = { name: "open_page", description: "Open a web page and read it.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, annotations: { readOnlyHint: true } };

async function callTool(name, args) {
  if (name === "search_notes") return { content: [{ type: "text", text: "Tomorrow: dentist at 3pm." }] };
  await new Promise((done) => setTimeout(done, 3_000));
  return { content: [{ type: "text", text: `${args?.url ?? "page"}: open 9 to 9, tables at 7pm Friday for 4.` }] };
}

const env = { ...process.env, AGENT_BUILTIN_MODEL: process.env.PROGRESS_EVAL_MODEL ?? DEFAULT_GATEWAY_MODEL };
const gateway = aiGatewayConfig(env);
if (gateway === null) {
  process.stderr.write("Set AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN (see this file's header).\n");
  process.exit(1);
}

for (const level of ["off", "planOnly", "normal"]) {
  for (const question of ASKS) {
    const bubbles = [];
    const channel = progressChannel(async (text) => bubbles.push(text), { level });
    const turn = await runTurn({
      question,
      credential: { provider: BUILTIN_PROVIDER, apiKey: null },
      tools: [SEARCH, OPEN],
      env,
      providerOptions: { gateway },
      texting: true,
      callTool,
      ...(channel.offered ? { progress: channel } : {}),
    });
    process.stdout.write(`\n[${level}] ${question}\n`);
    for (const line of bubbles) process.stdout.write(`  progress: ${line}\n`);
    process.stdout.write(`  answer:   ${(turn.answer ?? "").replace(/\s+/g, " ")}\n`);
  }
}
