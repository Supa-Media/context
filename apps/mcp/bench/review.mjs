/**
 * `pnpm ai review [--set <name,...>] [--concurrency <n>] [--fake]`
 *
 * Scores the reply reviewer (`src/agent/replyJudge.js`, one Haiku call; Dev2
 * 2026-11-06: "replace the judges with one haiku model that is able to
 * understand nuances and give feedback") on every labelled case in
 * `bench/review/<set>.json`: the old gates' sets (a case is `fault: true` when
 * the reply should go back) and `chat`, banter and roasts where a joke is
 * never a claim. Each case is put to the reviewer exactly as production puts
 * a draft (`judgeState`, the same system prompt, one call).
 *
 * The bar is for the whole reviewer at once, because that is what the person
 * meets: it must send back at least `MIN_CATCH` of the faults and at most
 * `MAX_FALSE_ALARMS` of the good replies, across every set. The ten gates were
 * each benched alone to 10% and together sent back 66% of Tex Devs' replies.
 *
 * Through the AI gateway (`AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`,
 * `AI_GATEWAY_TOKEN`). Nothing is written anywhere.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { aiGatewayConfig, requestViaGateway } from "../src/agent/aiGateway.js";
import { ANSWER_WAIT_MS, modelSocket, socketRequest } from "./modelSocket.mjs";
import { readHeldOut, writeRows } from "./replayGate.mjs";
import { judgeState, reviewReply } from "../src/agent/replyJudge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SETS = join(HERE, "review");
/** The most good replies the reviewer may send back, across every set. */
export const MAX_FALSE_ALARMS = 0.1;
/** The least of the faults it must send back, across every set. */
export const MIN_CATCH = 0.8;

/** A case's turn in the shape `judgeState` reads: `did` rows are [tool, args, result, "failed"?]; a report case has `report` ({ title, state, texts }); a routine or check-in case has `scheduled` ("routine" or "check-in"). */
export function caseTurn(item) {
  const history = (item.earlier ?? []).map(([who, text]) => ({ role: who === "tex" ? "assistant" : "user", text }));
  return judgeState({ question: item.q, history, messages: caseMessages(item), answer: item.reply, report: item.report ?? null, scheduled: item.scheduled ?? null });
}

/** A case's calls as the turn's messages. */
export function caseMessages(item) {
  const messages = [];
  for (const [name, args, result, failed] of item.did ?? []) {
    messages.push({ role: "assistant", text: "", toolCalls: [{ name, args: args ?? {} }] });
    messages.push({ role: "tool", name, text: String(result ?? ""), isError: failed === "failed" });
  }
  return messages;
}

/** Every set, by name: `{ [set]: cases }`. */
export async function loadSets(dir = SETS) {
  const sets = {};
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()) {
    const set = JSON.parse(await readFile(join(dir, file), "utf8"));
    sets[set.gate] = set.cases.map((item) => ({ ...item, id: `${set.gate}/${item.id}` }));
  }
  return sets;
}

/** Catches and false alarms over scored cases (`sent: false` is a send-back; `null` is no verdict, counted as sent). */
export function rates(scored) {
  const faults = scored.filter((item) => item.fault);
  const good = scored.filter((item) => !item.fault);
  const caught = faults.filter((item) => item.sent === false).length;
  const alarms = good.filter((item) => item.sent === false).length;
  return { caught, faults: faults.length, alarms, good: good.length, catch: faults.length ? caught / faults.length : 0, falseAlarms: good.length ? alarms / good.length : 0 };
}

/** Whether the reviewer clears the bar. */
export const passes = (row) => row.catch >= MIN_CATCH && row.falseAlarms <= MAX_FALSE_ALARMS;

/** Review every case, `concurrency` at a time. */
export async function scoreCases(cases, review, concurrency = 6) {
  const out = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (next < cases.length) {
        const at = next++;
        const item = cases[at];
        const seen = {};
        const started = Date.now();
        const verdict = await review(caseTurn(item), item, seen).catch((error) => ((seen.error = String(error?.message ?? error)), null));
        out[at] = { ...item, sent: verdict === null ? null : verdict.send, kind: verdict?.kind ?? null, problems: verdict?.problems ?? [], feedback: verdict?.feedback ?? "", ms: Date.now() - started, raw: seen.raw ?? null, error: seen.error ?? null };
      }
    }),
  );
  return out;
}

/** A stand-in reviewer for tests: sure of every label. */
const fakeReview = async (_state, item) => (item.fault ? { kind: "task", send: false, problems: ["unfinished"], feedback: "Fix it." } : { kind: "task", send: true, problems: [], feedback: "" });

export function reviewReport(sets, scored) {
  const pct = (value) => `${Math.round(value * 100)}%`;
  const all = rates(scored);
  const lines = [
    `## Reply reviewer ${passes(all) ? "✅ passes" : "❌ below the bar"}`,
    "",
    `Bar, across every set: send back at least ${pct(MIN_CATCH)} of faults and at most ${pct(MAX_FALSE_ALARMS)} of good replies.`,
    "",
    `**All:** catches ${all.caught}/${all.faults} (${pct(all.catch)}), false alarms ${all.alarms}/${all.good} (${pct(all.falseAlarms)})${scored.some((item) => item.sent === null) ? `, ${scored.filter((item) => item.sent === null).length} no verdict` : ""}.`,
    "",
    "| set | caught | false alarms |",
    "| --- | --- | --- |",
    ...Object.keys(sets).map((name) => {
      const row = rates(scored.filter((item) => item.id.startsWith(`${name}/`)));
      return `| ${name} | ${row.caught}/${row.faults} | ${row.alarms}/${row.good} |`;
    }),
    "",
  ];
  const times = scored.map((item) => item.ms).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length) lines.push(`Review time: median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)} s, slowest ${(times.at(-1) / 1000).toFixed(1)} s.`, "");
  const none = scored.filter((item) => item.sent === null);
  if (none.length) lines.push("No verdict:", ...none.map((item) => `- ${item.id}: ${item.error ?? (item.raw === null ? "no answer in time" : `answered ${JSON.stringify(item.raw.slice(0, 160))}`)}`), "");
  const missed = scored.filter((item) => item.fault && item.sent !== false);
  const alarms = scored.filter((item) => !item.fault && item.sent === false);
  if (missed.length) lines.push(`Missed: ${missed.map((item) => item.id).join(", ")}`, "");
  if (alarms.length) lines.push("False alarms:", ...alarms.map((item) => `- ${item.id} (${item.problems.join(", ") || "no problem named"}): ${item.feedback.replace(/\s+/g, " ").slice(0, 200)}`), "");
  return lines.join("\n");
}

/** An examiner answers in minutes, not the reviewer's 8 s: a socketed review waits as long as the socket does. */
export const reviewWait = (socket) => (socket?.covers("claude") ? { timeoutMs: ANSWER_WAIT_MS } : {});

export async function reviewCommand(options, { write = (text) => process.stdout.write(text) } = {}) {
  const sets = await loadSets();
  const names = options.set ? options.set.split(",") : Object.keys(sets);
  for (const name of names) if (!(name in sets)) throw new Error(`no set named ${name}`);
  // With the model socket (`modelSocket.mjs`) an examiner session answers the reviewer's Claude calls, and no key is needed.
  const socket = options.fake ? null : modelSocket(process.env);
  const send = socket?.covers("claude") ? socketRequest(socket) : requestViaGateway;
  const config = socket?.covers("claude") ? null : aiGatewayConfig(process.env);
  if (!options.fake && !socket?.covers("claude") && config === null) throw new Error("set AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN");
  // Each answer's raw text is kept, so a review with no verdict says why.
  const review = options.fake ? fakeReview : (state, _item, seen) => reviewReply({ state, config, metadata: { feature: "bench", client: "reviewer" }, ...reviewWait(socket), request: async (...args) => { const reply = await send(...args); seen.raw = String(reply?.text ?? ""); return reply; } });
  const chosen = Object.fromEntries(names.map((name) => [name, sets[name]]));
  // `--held-out <dir>` adds the cases kept outside the repository (`replayGate.mjs`); `--only a,b` scores those ids alone.
  const only = options.only ? new Set(String(options.only).split(",")) : null;
  const cases = [...Object.values(chosen).flat(), ...(await readHeldOut(options["held-out"], "review"))].filter((item) => !only || only.has(item.id));
  const scored = await scoreCases(cases, review, Number(options.concurrency ?? 6));
  // A held-out case's words never reach the report: it counts in the rates and is named by its cause alone.
  const held = scored.filter((item) => item.heldOut);
  const wrong = held.filter((item) => (item.fault ? item.sent !== false : item.sent !== true));
  write(`${reviewReport(chosen, scored.filter((item) => !item.heldOut))}\n${held.length ? `Held-out: ${held.length - wrong.length}/${held.length} right${wrong.length ? `; wrong about ${[...new Set(wrong.map((item) => item.cause))].join(", ")}` : ""}.\n` : ""}`);
  if (options.json) await writeRows(options.json, "review", scored);
  return rates(scored);
}
