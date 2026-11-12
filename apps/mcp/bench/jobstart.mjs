/**
 * `pnpm ai jobstart [--concurrency <n>] [--fake]`
 *
 * Scores how the front door starts a job: with a line of its own (`say`) or only a tapback (Dev2, 2026-11-12: "some
 * jobs don't need it, some jobs do need it ... we need specific examples of conversations"). The examples it is
 * taught by are `src/agent/jobStart.js`; the cases here are other chats (`bench/jobstart/cases.json`).
 *
 * Each case is put to Haiku with the job rules and examples as the front door has them (`backgroundSession().prompt`)
 * and the job tools, made to start or restart a job, so the only thing judged is the `say`. Two bars: at least
 * `MIN_LINES` of the starts that need a line get one, and at least `MIN_TAPS` of the ones better as a tapback stay one.
 *
 * Claude through the AI gateway or the API (`claudeTransport`). `--fake` checks the plumbing only: its stand-in answers
 * by the label, so it proves nothing about judgment. Nothing is written anywhere.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RESTART_JOB_TOOL, START_JOB_TOOL, backgroundSession } from "../src/agent/background.js";
import { startLine } from "../src/agent/jobStart.js";
import { claudeTransport } from "./models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CASES = join(HERE, "jobstart", "cases.json");
export const MODEL = "claude-haiku-5-5";
/** The least of the starts that need a line that must get one. */
export const MIN_LINES = 0.8;
/** The least of the starts better as a tapback that must stay one. */
export const MIN_TAPS = 0.8;

export async function loadCases(path = CASES) {
  return JSON.parse(await readFile(path, "utf8")).cases;
}

/** The Messages API body for one case: the job rules and examples, the two job tools, and the chat with its newest text. */
export function caseBody(item) {
  const session = backgroundSession({ running: [], job: null, now: Date.now() });
  const tools = session.tools.filter((tool) => tool.name === START_JOB_TOOL || tool.name === RESTART_JOB_TOOL);
  const chat = [...item.lines, item.text].join("\n");
  return {
    model: MODEL,
    max_tokens: 1_000,
    system: `You are Tex, an assistant people text${item.chat === "group" ? ", here in a group chat" : ""}.${session.prompt}`,
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: `The chat so far, newest last:\n${chat}\n\nStart the work their newest text asks for now.` }],
  };
}

/** What Tex sent with the start: "line" or "tap", or null with no job call. */
export function readStart(response) {
  const call = (response?.content ?? []).find((part) => part.type === "tool_use");
  if (!call) return null;
  return { said: startLine(call.input?.say) === "" ? "tap" : "line", line: startLine(call.input?.say), tool: call.name };
}

export function rates(scored) {
  const want = (kind) => scored.filter((item) => item.want === kind);
  const lines = want("line"), taps = want("tap");
  const lined = lines.filter((item) => item.got?.said === "line").length;
  const tapped = taps.filter((item) => item.got?.said === "tap").length;
  return { lined, lines: lines.length, tapped, taps: taps.length, lineRate: lines.length ? lined / lines.length : 0, tapRate: taps.length ? tapped / taps.length : 0 };
}

export const passes = (row) => row.lineRate >= MIN_LINES && row.tapRate >= MIN_TAPS;

/** A stand-in Claude for the plumbing: it reads the case's own label off its newest text. */
export function fakeSend(cases) {
  const byText = new Map(cases.map((item) => [item.text, item.want]));
  return async (raw) => {
    const body = JSON.parse(raw);
    const content = body.messages[0].content;
    const want = cases.find((item) => content.includes(item.text)) ? byText.get(cases.find((item) => content.includes(item.text)).text) : "tap";
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: START_JOB_TOOL, input: { title: "x", brief: "x", ...(want === "line" ? { say: "On it, a page in a few minutes." } : {}) } }] }), { status: 200 });
  };
}

export async function scoreCases(cases, send, concurrency = 4) {
  const out = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (next < cases.length) {
        const at = next++;
        const item = cases[at];
        const response = await send(JSON.stringify(caseBody(item))).catch(() => null);
        const got = response?.status === 200 ? readStart(await response.json().catch(() => null)) : null;
        out[at] = { ...item, got };
      }
    }),
  );
  return out;
}

export function jobstartReport(scored) {
  const pct = (value) => `${Math.round(value * 100)}%`;
  const all = rates(scored);
  const lines = [
    `## Job starts, a line or a tapback ${passes(all) ? "✅ passes" : "❌ below the bar"}`,
    "",
    `**Line when needed:** ${all.lined}/${all.lines} (${pct(all.lineRate)}). **Tapback when enough:** ${all.tapped}/${all.taps} (${pct(all.tapRate)}).`,
    "",
  ];
  const none = scored.filter((item) => item.got === null);
  if (none.length) lines.push(`No job call: ${none.map((item) => item.id).join(", ")}`, "");
  const wrong = scored.filter((item) => item.got !== null && item.got.said !== item.want);
  if (wrong.length) lines.push("Missed:", ...wrong.map((item) => `- ${item.id} (wanted ${item.want})${item.got.line ? `: "${item.got.line}"` : ""}`), "");
  const said = scored.filter((item) => item.got?.said === "line" && item.want === "line");
  if (said.length) lines.push("Lines it wrote:", ...said.map((item) => `- ${item.id}: "${item.got.line}"`), "");
  return lines.join("\n");
}

export async function jobstartCommand(options, { write = (text) => process.stdout.write(text) } = {}) {
  const cases = await loadCases();
  const send = options.fake ? fakeSend(cases) : claudeTransport(process.env);
  if (!options.fake && send.route === null) throw new Error("set AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN, or ANTHROPIC_API_KEY");
  const scored = await scoreCases(cases, send, Number(options.concurrency ?? 4));
  write(`${jobstartReport(scored)}\n`);
  return rates(scored);
}
