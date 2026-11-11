/**
 * `pnpm ai respond [--concurrency <n>] [--fake]`
 *
 * Scores Tex's one judge (`packages/shared/src/textDecide.cjs`; Dev2, 2026-11-11: one Clef judge, taught by
 * examples, decides respond, react or quiet) on the held-out labelled cases in `bench/respond/cases.json`, taken from
 * real chats with the names changed. Each case is put to the judge exactly as the Worker puts a moment: the same
 * body (`decideRequest`), the same examples, the same answer reading (`readDecideAnswers`).
 *
 * Three bars: of the texts that should get no text back (`want: "hush"`), at least `MIN_HUSHED` are quiet or a
 * tapback; of those that must reach the model (`want: "reply"`), at most `MAX_DROPPED` are hushed; and of the owner's
 * "@Tex must still work" set (`must: true`), none is. A dropped ask is the costly mistake, so its bars are the tight ones.
 *
 * Clef through the Workers AI REST API (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN`). `--fake` checks the plumbing
 * only: its stand-in judge answers by the label, so it proves nothing about judgment. Nothing is written anywhere.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decisionEngine } from "../src/agent/decide.js";
import { decideRequest, readDecideAnswers } from "../../../packages/shared/src/textDecide.cjs";
import { workersAi } from "./models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CASES = join(HERE, "respond", "cases.json");
/** The least of the should-be-quiet texts that must get no text back. */
export const MIN_HUSHED = 0.8;
/** The most of the must-answer texts that may be hushed. */
export const MAX_DROPPED = 0.05;

export async function loadCases(path = CASES) {
  return JSON.parse(await readFile(path, "utf8")).cases;
}

const eventId = (index) => `${1_762_000_000_000 + index * 1_000}-${String(index + 1).padStart(6, "0")}`;
const SETTINGS = { quiet: "quiet", attentive: "attentive", "follow along": "followAlong", helpful: "helpful" };

/** A case as the Worker's body to the judge: its lines and text as the transcript, one id a line, the newest the text. */
export function caseBody(item) {
  const said = [...item.lines, item.text];
  const transcript = said.map((line, index) => `<${eventId(index)}> ${line}`).join("\n");
  const newest = eventId(said.length - 1);
  const group = item.chat === "group";
  return {
    chat: group ? "bench-group" : "+15555550100",
    style: group ? (SETTINGS[item.setting ?? "follow along"] ?? "followAlong") : "direct",
    transcript,
    candidates: [newest],
    running: false,
    waitingAsks: [],
    newest,
    ...(group ? { line: "+15555550199" } : { sender: "+15555550100" }),
  };
}

/** The judge's verdict on one case: `(state, questions) => answers` is Clef's engine (`decisionEngine`). */
export async function judgeCase(item, engine) {
  const body = caseBody(item);
  const asked = decideRequest(body);
  const answers = await engine(asked.state, asked.questions);
  return answers === null ? null : readDecideAnswers(body, answers);
}

/** Whether a verdict ends with no text back: quiet or a tapback. A wait is answered once the burst ends. */
export const hushed = (verdict) => verdict?.ok === true && (verdict.act === "silent" || verdict.act === "react");

export function rates(scored) {
  const hush = scored.filter((item) => item.want === "hush");
  const reply = scored.filter((item) => item.want === "reply");
  const must = scored.filter((item) => item.must === true);
  const quieted = hush.filter((item) => item.hushed).length;
  const dropped = reply.filter((item) => item.hushed).length;
  const mustDropped = must.filter((item) => item.hushed || item.verdict?.ok !== true).length;
  return { quieted, hush: hush.length, dropped, reply: reply.length, mustDropped, must: must.length, hushedRate: hush.length ? quieted / hush.length : 0, droppedRate: reply.length ? dropped / reply.length : 0 };
}

export const passes = (row) => row.hushedRate >= MIN_HUSHED && row.droppedRate <= MAX_DROPPED && row.mustDropped === 0;

export async function scoreCases(cases, engine, concurrency = 6) {
  const out = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (next < cases.length) {
        const at = next++;
        const item = cases[at];
        const started = Date.now();
        const verdict = await judgeCase(item, engine).catch(() => null);
        out[at] = { ...item, verdict, hushed: hushed(verdict), ms: Date.now() - started };
      }
    }),
  );
  return out;
}

/** A stand-in Clef for the plumbing: it finds the case's own label on the newest line, so it is sure of every one. */
export function fakeEngine(cases) {
  const byText = new Map(cases.map((item) => [item.text, item.want]));
  return async (state) => {
    const newest = state.slice(0, state.lastIndexOf("\n</chat>")).split("\n").at(-1).replace(/^<[^>]+> /, "");
    const want = byText.get(newest);
    return { act: { choice: want === "hush" ? "quiet" : "respond", confidence: 1 }, why: { choice: want === "hush" ? "people_talking" : "asks_tex" } };
  };
}

export function respondReport(scored) {
  const pct = (value) => `${Math.round(value * 100)}%`;
  const all = rates(scored);
  const lines = [
    `## Reply or quiet, the one judge ${passes(all) ? "✅ passes" : "❌ below the bar"}`,
    "",
    `Bar: at least ${pct(MIN_HUSHED)} of should-be-quiet texts get no text back, at most ${pct(MAX_DROPPED)} of must-answer texts are hushed, and none of the @Tex set.`,
    "",
    `**Quiet when it should be:** ${all.quieted}/${all.hush} (${pct(all.hushedRate)}). **Dropped asks:** ${all.dropped}/${all.reply} (${pct(all.droppedRate)}). **@Tex set missed:** ${all.mustDropped}/${all.must}.`,
    "",
  ];
  const times = scored.map((item) => item.ms).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length) lines.push(`Judge time: median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)} s, slowest ${(times.at(-1) / 1000).toFixed(1)} s.`, "");
  const none = scored.filter((item) => item.verdict?.ok !== true);
  if (none.length) lines.push(`No verdict: ${none.map((item) => item.id).join(", ")}`, "");
  const talked = scored.filter((item) => item.want === "hush" && !item.hushed && item.verdict?.ok === true);
  const dropped = scored.filter((item) => item.want === "reply" && item.hushed);
  if (talked.length) lines.push("Talked when it should not have:", ...talked.map((item) => `- ${item.id} (${item.verdict.act}): ${item.verdict.why ?? ""}`), "");
  if (dropped.length) lines.push("Dropped:", ...dropped.map((item) => `- ${item.id}${item.must ? " (@Tex set)" : ""} (${item.verdict.act}): ${item.verdict.why ?? ""}`), "");
  return lines.join("\n");
}

export async function respondCommand(options, { write = (text) => process.stdout.write(text) } = {}) {
  const cases = await loadCases();
  if (!options.fake && !(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN)) throw new Error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN");
  const engine = options.fake ? fakeEngine(cases) : decisionEngine(workersAi(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_AI_TOKEN));
  const scored = await scoreCases(cases, engine, Number(options.concurrency ?? 6));
  write(`${respondReport(scored)}\n`);
  return rates(scored);
}
