/**
 * `pnpm ai gates [--gate <name>] [--model clef-flash|clef] [--concurrency <n>] [--fake]`
 *
 * Scores each reply gate (`src/agent/replyGates.js`) on its own labelled set
 * (`bench/gates/<gate>.json`), the way Dev2 asked for them to be tuned one by
 * one (2026-11-05: "make sure each of these judges are also well tuned").
 *
 * A case is one reply with what the turn did, labelled `fault: true` when the
 * gate should send it back. Every case is put to the gate exactly as
 * production puts it (`judgeState`, the same packet, one Clef call per gate),
 * and so is every good reply from the other gates' sets, because a gate that
 * fires on another gate's good reply is a false alarm too. For each gate it
 * reports how many faults it catches and how many good replies it sends back
 * at each threshold, and picks the threshold that catches the most while
 * sending back at most `MAX_FALSE_ALARMS` of the good ones. A gate passes its
 * bar when, at that threshold, it catches at least `MIN_CATCH` of its faults.
 *
 * Nothing here is written anywhere: the tuned thresholds are printed for a
 * person to put in `replyGates.js` (`at`), with the cases each gate missed.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decisionEngine } from "../src/agent/decide.js";
import { JUDGE_MODELS, judgeState } from "../src/agent/replyJudge.js";
import { GATES, gateQuestion } from "../src/agent/replyGates.js";
import { workersAi } from "./models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SETS = join(HERE, "gates");
/** The most good replies a tuned gate may send back. */
export const MAX_FALSE_ALARMS = 0.1;
/** The least of its faults a gate must catch to pass its bar. */
export const MIN_CATCH = 0.8;
const THRESHOLDS = Array.from({ length: 17 }, (_, i) => Math.round((0.1 + i * 0.05) * 100) / 100);

/** A case's turn in the shape `judgeState` reads: `did` rows are [tool, args, result, "failed"?]. */
export function caseTurn(item) {
  const messages = [];
  for (const [name, args, result, failed] of item.did ?? []) {
    messages.push({ role: "assistant", text: "", toolCalls: [{ name, args: args ?? {} }] });
    messages.push({ role: "tool", name, text: String(result ?? ""), isError: failed === "failed" });
  }
  const history = (item.earlier ?? []).map(([who, text]) => ({ role: who === "tex" ? "assistant" : "user", text }));
  return judgeState({ question: item.q, history, messages, answer: item.reply });
}

export async function loadSets(dir = SETS) {
  const sets = {};
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()) {
    const set = JSON.parse(await readFile(join(dir, file), "utf8"));
    if (!(set.gate in GATES)) throw new Error(`${file}: no gate named ${set.gate}`);
    sets[set.gate] = set.cases;
  }
  return sets;
}

/** Every case a gate is scored on: its own, and the other gates' good replies (`cross`). */
export function casesFor(gate, sets) {
  const own = (sets[gate] ?? []).map((item) => ({ ...item, cross: false }));
  const others = Object.entries(sets)
    .filter(([name]) => name !== gate)
    .flatMap(([name, cases]) => cases.filter((item) => !item.fault).map((item) => ({ ...item, id: `${name}/${item.id}`, fault: false, cross: true })));
  return [...own, ...others];
}

/** Catches and false alarms at one threshold. */
export function rates(scored, at) {
  const faults = scored.filter((item) => item.fault && typeof item.yes === "number");
  const good = scored.filter((item) => !item.fault && typeof item.yes === "number");
  const caught = faults.filter((item) => item.yes >= at).length;
  const alarms = good.filter((item) => item.yes >= at).length;
  return { at, catch: faults.length ? caught / faults.length : 0, falseAlarms: good.length ? alarms / good.length : 0, caught, faults: faults.length, alarms, good: good.length };
}

/** The threshold that catches the most with false alarms at or under the cap; the fewest false alarms when none is. */
export function tune(scored) {
  const all = THRESHOLDS.map((at) => rates(scored, at));
  const within = all.filter((row) => row.falseAlarms <= MAX_FALSE_ALARMS);
  const best = within.length
    ? within.reduce((a, b) => {
        if (b.catch !== a.catch) return b.catch > a.catch ? b : a;
        if (b.falseAlarms !== a.falseAlarms) return b.falseAlarms < a.falseAlarms ? b : a;
        return Math.abs(b.at - 0.5) < Math.abs(a.at - 0.5) ? b : a; // a tie keeps the threshold nearest an even call
      })
    : all.reduce((a, b) => (b.falseAlarms < a.falseAlarms || (b.falseAlarms === a.falseAlarms && b.catch > a.catch) ? b : a));
  return { best, passes: best.falseAlarms <= MAX_FALSE_ALARMS && best.catch >= MIN_CATCH, all };
}

/** Run every case through its gate, `concurrency` calls at a time. */
export async function scoreGate(gate, cases, decide, concurrency = 8) {
  const out = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (next < cases.length) {
        const at = next++;
        const answers = await decide(caseTurn(cases[at]), gateQuestion(gate));
        const yes = answers?.[gate]?.noul;
        out[at] = { ...cases[at], yes: typeof yes === "number" && Number.isFinite(yes) ? yes : null };
      }
    }),
  );
  return out;
}

/** A stand-in decision model for tests: sure of every label. */
function fakeDecide(sets) {
  const byReply = new Map(Object.values(sets).flat().map((item) => [item.reply, item.fault]));
  return async (state, questions) => {
    const [name] = Object.keys(questions);
    const reply = /The reply about to be sent: ([\s\S]*?)\n\n/.exec(state)?.[1] ?? "";
    return { [name]: { noul: byReply.get(reply) ? 0.9 : 0.1 } };
  };
}

export function gateReport(gate, scored, tuned) {
  const { best, passes } = tuned;
  const missed = scored.filter((item) => item.fault && typeof item.yes === "number" && item.yes < best.at);
  const alarms = scored.filter((item) => !item.fault && typeof item.yes === "number" && item.yes >= best.at);
  const unanswered = scored.filter((item) => item.yes === null).length;
  const pct = (value) => `${Math.round(value * 100)}%`;
  return [
    `### ${gate} ${passes ? "✅ passes" : "❌ below the bar"}`,
    "",
    `At ${best.at}: catches ${best.caught}/${best.faults} (${pct(best.catch)}), false alarms ${best.alarms}/${best.good} (${pct(best.falseAlarms)})${unanswered ? `, ${unanswered} unanswered` : ""}.`,
    ...(missed.length ? ["", `Missed: ${missed.map((item) => `${item.id} (${item.yes.toFixed(2)})`).join(", ")}`] : []),
    ...(alarms.length ? ["", `False alarms: ${alarms.map((item) => `${item.id} (${item.yes.toFixed(2)})`).join(", ")}`] : []),
    "",
  ].join("\n");
}

export async function gatesCommand(options) {
  const sets = await loadSets();
  const model = options.model ?? "clef-flash";
  if (!(model in JUDGE_MODELS)) throw new Error(`--model is one of ${Object.keys(JUDGE_MODELS).join(", ")}`);
  const decide = options.fake ? fakeDecide(sets) : decisionEngine(workersAi(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_AI_TOKEN), JUDGE_MODELS[model]);
  const names = options.gate ? options.gate.split(",") : Object.keys(GATES);
  const lines = [`## Reply gates on ${model}`, "", `Bar: catch at least ${MIN_CATCH * 100}% of a gate's faults while sending back at most ${MAX_FALSE_ALARMS * 100}% of good replies (its own and every other gate's).`, ""];
  const tunedAt = {};
  let passed = 0;
  for (const gate of names) {
    if (!(gate in GATES)) throw new Error(`no gate named ${gate}`);
    const scored = await scoreGate(gate, casesFor(gate, sets), decide, Number(options.concurrency ?? 8));
    const tuned = tune(scored);
    tunedAt[gate] = tuned.best.at;
    if (tuned.passes) passed += 1;
    lines.push(gateReport(gate, scored, tuned));
  }
  lines.push(`**${passed} of ${names.length} gates pass.** Tuned thresholds: \`${JSON.stringify(tunedAt)}\``);
  process.stdout.write(`${lines.join("\n")}\n`);
  return { passed, tunedAt };
}
