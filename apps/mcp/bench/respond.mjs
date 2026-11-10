/**
 * `pnpm ai respond [--concurrency <n>] [--fake]`
 *
 * Scores the conversation classifier's reply-or-quiet call (`src/agent/respond.js`; Dev2, 2026-11-10: "have an
 * output based on examples that's a 'no response'") on the labelled cases in `bench/respond/cases.json`, taken from
 * real chats with the names changed. Each case is put to the classifier exactly as a turn puts a text
 * (`classifyText`, the same system prompt and examples, one call), and code's floor (`mayHush`) is applied as in
 * production, since that is what the person meets.
 *
 * Two numbers, two bars: of the texts that should get no text back (`want: "hush"`), at least `MIN_HUSHED` are quiet
 * or a tapback; of those that must reach the model (`want: "reply"`), at most `MAX_DROPPED` are hushed. A dropped
 * ask is the costly mistake, so its bar is the tight one.
 *
 * Through the AI gateway (`AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`, `AI_GATEWAY_TOKEN`). Nothing is written anywhere.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { aiGatewayConfig, requestViaGateway } from "../src/agent/aiGateway.js";
import { classifyText } from "../src/agent/conversationThreads.js";
import { lastTexBefore, mayHush } from "../src/agent/respond.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CASES = join(HERE, "respond", "cases.json");
/** The least of the should-be-quiet texts that must get no text back. */
export const MIN_HUSHED = 0.8;
/** The most of the must-answer texts that may be hushed. */
export const MAX_DROPPED = 0.05;

export async function loadCases(path = CASES) {
  return JSON.parse(await readFile(path, "utf8")).cases;
}

/** A case's lines as shown events, for code's floor: "You: …" is Tex's, anything else a person's. */
export function caseEvents(item) {
  return item.lines.map((line, index) => ({ id: `e${index}`, from: { kind: /^You: /.test(line) ? "tex" : "person" }, text: line.replace(/^You: /, "") }));
}

/** Whether a case's text ends with no text back: the classifier's quiet or react, past code's floor. */
export function hushed(item, verdict) {
  const { lastTex, between } = lastTexBefore(caseEvents(item));
  return mayHush({ verdict, text: item.text, group: item.chat === "group", lastTex, between });
}

export function rates(scored) {
  const hush = scored.filter((item) => item.want === "hush");
  const reply = scored.filter((item) => item.want === "reply");
  const quieted = hush.filter((item) => item.hushed).length;
  const dropped = reply.filter((item) => item.hushed).length;
  return { quieted, hush: hush.length, dropped, reply: reply.length, hushedRate: hush.length ? quieted / hush.length : 0, droppedRate: reply.length ? dropped / reply.length : 0 };
}

export const passes = (row) => row.hushedRate >= MIN_HUSHED && row.droppedRate <= MAX_DROPPED;

export async function scoreCases(cases, classify, concurrency = 6) {
  const out = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (next < cases.length) {
        const at = next++;
        const item = cases[at];
        const started = Date.now();
        const verdict = await classify(item).catch(() => null);
        out[at] = { ...item, verdict, hushed: verdict !== null && hushed(item, verdict), ms: Date.now() - started };
      }
    }),
  );
  return out;
}

/** A stand-in classifier for tests: sure of every label. */
const fakeClassify = async (item) => ({ thread: "new", title: "x", description: "", finished: [], respond: item.want === "hush" ? "quiet" : "reply" });

export function respondReport(scored) {
  const pct = (value) => `${Math.round(value * 100)}%`;
  const all = rates(scored);
  const lines = [
    `## Reply or quiet ${passes(all) ? "✅ passes" : "❌ below the bar"}`,
    "",
    `Bar: at least ${pct(MIN_HUSHED)} of should-be-quiet texts get no text back, at most ${pct(MAX_DROPPED)} of must-answer texts are hushed.`,
    "",
    `**Quiet when it should be:** ${all.quieted}/${all.hush} (${pct(all.hushedRate)}). **Dropped asks:** ${all.dropped}/${all.reply} (${pct(all.droppedRate)}).`,
    "",
  ];
  const times = scored.map((item) => item.ms).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length) lines.push(`Classifier time: median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)} s, slowest ${(times.at(-1) / 1000).toFixed(1)} s.`, "");
  const none = scored.filter((item) => item.verdict === null);
  if (none.length) lines.push(`No verdict: ${none.map((item) => item.id).join(", ")}`, "");
  const talked = scored.filter((item) => item.want === "hush" && !item.hushed);
  const dropped = scored.filter((item) => item.want === "reply" && item.hushed);
  if (talked.length) lines.push("Talked when it should not have:", ...talked.map((item) => `- ${item.id} (${item.verdict?.respond ?? "none"}): ${item.verdict?.why ?? ""}`), "");
  if (dropped.length) lines.push("Dropped:", ...dropped.map((item) => `- ${item.id} (${item.verdict?.respond}): ${item.verdict?.why ?? ""}`), "");
  return lines.join("\n");
}

export async function respondCommand(options, { write = (text) => process.stdout.write(text) } = {}) {
  const cases = await loadCases();
  const config = aiGatewayConfig(process.env);
  if (!options.fake && config === null) throw new Error("set AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN");
  const classify = options.fake
    ? fakeClassify
    : (item) => classifyText({ threads: [], lines: { byThread: new Map(), recent: item.lines }, question: item.text, replying: [], group: item.chat === "group", config, metadata: { feature: "bench", client: "threads" }, request: requestViaGateway, timeoutMs: 15_000 });
  const scored = await scoreCases(cases, classify, Number(options.concurrency ?? 6));
  write(`${respondReport(scored)}\n`);
  return rates(scored);
}
