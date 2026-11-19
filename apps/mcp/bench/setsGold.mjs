/**
 * `node apps/mcp/bench/setsGold.mjs [--set training] [--conversations <file.json>] [--out <report.json>] [--fake] [--judge <model>]`
 *
 * The gold self-check (Dev2, 2026-11-18: the Front door judge read Training labels with no check that the
 * conversation's own gold Tex reply passes them; running-the-shop 2 and trial-hire 66 were labels their own gold
 * text broke). For every starred Front door label in a Training conversation, the conversation's OWN gold Tex texts
 * after that row are judged against the row's must and never lines, through the same request builder a run uses
 * (`buildJudgeRequest` in `judge.mjs`). A label its own gold reply fails is reported, with the judge's reason, as
 * ambiguous. Nothing here changes a label: a person decides what the label or the gold should say.
 *
 * Training words are public, so the failures are printed with their label lines; no message text beyond those lines
 * and the judge's reason is printed. Only the Training set is read: the Dev and Test sets are never judged here.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { DEFAULT_JUDGE, buildJudgeRequest, fakeJudge } from "./judge.mjs";
import { assertAnswered, modelSocket, socketSend } from "./modelSocket.mjs";
import { loadSets } from "./sets.mjs";
import { burstBefore, earlierLines, titleOf } from "./setsFd.mjs";
import { sentPicturesLine } from "../src/agent/outgoingPictures.js";
import { tapbackLine } from "./run.mjs";

const { unitTests } = createRequire(import.meta.url)("../../../packages/shared/src/texSets.cjs");

/** How many times a judge reply that is not parseable is asked again. */
export const GOLD_ATTEMPTS = 3;
const GOLD_ID = "gold";
const NO_TOOLS = "Tools: not recorded (the conversation's own reply, as written)";
const TAPBACK_QUOTE = 60;
/** The one line the gold answer's changes carry (the run's own answers carry their recorded changes). */
export const GOLD_CHANGES = "not recorded: this is the conversation's own reply, kept as texts only; what its texts say was done (edited, moved, sent, made) was done";

/** A tapback on the row's own text, or on another text, as the judge reads it. */
function tapbackTurn(c, row, m) {
  const emoji = String(m.text ?? "").trim();
  if (m.to === row.id) return { from: "assistant", text: tapbackLine(m.text), tapback: true };
  const target = String(c.msgs.find((x) => x.id === m.to)?.text ?? "").slice(0, TAPBACK_QUOTE);
  const said = emoji === "" ? `(Tex reacted to their text "${target}")` : `(Tex reacted ${emoji} to their text "${target}")`;
  return { from: "assistant", text: said, tapback: true };
}

/**
 * A gold text as the run's record says it: a set writes a picture Tex sent as "[picture: what it shows]", and a run's
 * answer says it as the chat's own record does (`run.mjs` saidLine, `outgoingPictures.js` sentPicturesLine), so the
 * judge reads a sent picture, not a bracketed description (build-crew 8 failed "actually make the picture" on that).
 */
export function textOf(text) {
  const captions = [];
  const words = String(text ?? "").replace(/\[picture:\s*([^\]]*)\]/g, (_, caption) => (captions.push(caption.trim()), "")).replace(/[ \t]+$/gm, "").trim();
  return [words, sentPicturesLine(captions, captions)].filter(Boolean).join("\n");
}

/** The tapbacks that start a job (`setsFd.mjs` JOB_TAPBACKS): Tex's whole answer of one means a job was started. */
const JOB_TAPBACKS = new Set(["🔎", "🕵"]);

/**
 * The job a gold answer started, as a run's answer lists it (`jobs_started`): a 🔎 or 🕵️ tapback with no words of Tex's
 * after it, titled from the ask as a job's title is (`setsFd.mjs` titleOf, runningJobOf). Without it "react first, then
 * go look" failed its own gold, whose look came back texts later.
 */
export function goldJobs(c, i, gold) {
  const started = gold.some((t) => t.tapback && JOB_TAPBACKS.has(String(c.msgs.find((m, k) => k > i && m.tex && m.kind === "react")?.text ?? "").replace(/\uFE0F/g, "").trim()));
  const words = gold.some((t) => !t.tapback);
  return started && !words ? [{ title: titleOf(askOf(c, i).replace(/\s+/g, " ").trim()) }] : [];
}

/**
 * The Tex messages right after row `i`, up to the first message that is not Tex's: a person's line, a trigger line
 * (`via`) or any other non-Tex message. Tex's edits and deletes are skipped.
 */
export function goldOf(c, i) {
  const row = c.msgs[i];
  const turns = [];
  for (const m of c.msgs.slice(i + 1)) {
    if (!m.tex || m.via) break;
    if (m.kind === "edit" || m.kind === "delete") continue;
    if (m.kind === "react") turns.push(tapbackTurn(c, row, m));
    else turns.push({ from: "assistant", text: textOf(m.text) });
  }
  return turns;
}

/**
 * What the gold reply answers, as the run's turn has it: the person's texts sent together before the row and the row
 * (`setsFd.mjs` burstBefore), or, for a check-in, routine or job report, what fired the turn nobody texted.
 */
export function askOf(c, i) {
  const m = c.msgs[i];
  if (m.via) return `(no text: Tex's ${m.via} ran) ${String(m.text ?? "")}`;
  return [...burstBefore(c, i), String(m.text ?? "")].filter(Boolean).join("\n");
}

/**
 * The judge requests for every starred Front door label in the Training conversations, and the rows that were skipped
 * (no gold Tex reply after them, or no must or never line). Each request carries the row's identity and its checks,
 * in the order the verdicts come back.
 */
export function goldRequests(convs, { model = DEFAULT_JUDGE } = {}) {
  const requests = [];
  const skipped = [];
  for (const c of convs.filter((conv) => conv.set === "training")) {
    for (const test of unitTests(c).filter((t) => t.node === "fd")) {
      const i = test.at;
      const row = c.msgs[i];
      const label = row.labels.fd;
      const skip = (why) => skipped.push({ convId: c.id, msgIndex: i, why });
      const gold = goldOf(c, i);
      if (gold.length === 0) {
        skip("no gold Tex reply after it");
        continue;
      }
      const must = label.must ?? [];
      const mustNot = label.never ?? [];
      if (must.length + mustNot.length === 0) {
        skip("no must or never line");
        continue;
      }
      const question = {
        n: requests.length + 1,
        text: row.text,
        must,
        mustNot,
        judge: [],
        may: [],
        earlier: earlierLines(c, i),
        gate: false,
      };
      const answer = {
        id: GOLD_ID,
        as: null,
        conversation: [{ from: "person", text: askOf(c, i) }, ...gold],
        toolsLine: NO_TOOLS,
        // The set keeps only the texts, never the tools or changes behind them. The gold is what Tex did, so what its
        // texts say was done (a note edited, a slot moved, a picture sent) is taken as done, not failed as unrecorded.
        changes: [GOLD_CHANGES],
        jobs: goldJobs(c, i, gold),
      };
      // codeLines off: a gold reply keeps only its texts, so every line is the judge's, as before the record graded any.
      const { checks, body } = buildJudgeRequest({ model, question, answers: [answer], every: [], codeLines: false });
      requests.push({ convId: c.id, msgIndex: i, msgId: row.id, checks, body });
    }
  }
  return { requests, skipped };
}

/** The verdicts for the one gold answer, asked again when the reply is not parseable. */
async function verdictsOf(send, body, checks) {
  let problem = "no reply";
  for (let attempt = 1; attempt <= GOLD_ATTEMPTS; attempt += 1) {
    const response = await send(body);
    if (!response.ok) throw new Error(`gold judge call failed: status ${response.status}`);
    const reply = await response.json();
    const text = (reply.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
    try {
      const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      const entry = (Array.isArray(parsed?.answers) ? parsed.answers : []).find((a) => a?.id === GOLD_ID);
      const verdicts = entry?.verdicts;
      if (!Array.isArray(verdicts)) throw new Error("no verdicts");
      if (verdicts.length !== checks.length) throw new Error(`${verdicts.length} verdicts for ${checks.length} checks`);
      if (verdicts.some((v) => typeof v?.does !== "boolean")) throw new Error("a verdict has no does: true or false");
      return verdicts;
    } catch (error) {
      problem = error.message;
    }
  }
  throw new Error(`gold judge reply is not usable (${problem}) after ${GOLD_ATTEMPTS} attempts`);
}

/**
 * Judges every gold reply against its row's lines. A must line passes when the judge says the reply does it; a must
 * not line passes when it does not. Returns the rows judged, the failing rows with the judge's reasons, and the skips.
 */
export async function goldCheck(convs, { send, model = DEFAULT_JUDGE, concurrency = 4 } = {}) {
  const { requests, skipped } = goldRequests(convs, { model });
  const results = new Array(requests.length);
  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const index = next;
      next += 1;
      const request = requests[index];
      const verdicts = await verdictsOf(send, request.body, request.checks);
      const failed = [];
      request.checks.forEach((check, k) => {
        const passes = check.kind === "must" ? verdicts[k].does : !verdicts[k].does;
        if (!passes) failed.push({ kind: check.kind, line: check.line, reason: String(verdicts[k].reason ?? "") });
      });
      results[index] = failed.length ? { convId: request.convId, msgIndex: request.msgIndex, msgId: request.msgId, failed } : null;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, requests.length)) }, worker));
  return { model, rows: requests.length, goldFails: results.filter(Boolean), skipped };
}

const flag = (args, name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

async function main(args) {
  const set = flag(args, "--set") ?? "training";
  if (set !== "training") throw new Error("the gold self-check reads Training labels only");
  const file = flag(args, "--conversations");
  const all = file ? JSON.parse(await readFile(file, "utf8")) : await loadSets();
  if (!Array.isArray(all)) throw new Error(`${file} is not a list of conversations`);
  const training = all.filter((c) => c.set === "training");
  const model = flag(args, "--judge") ?? DEFAULT_JUDGE;

  let socket = null;
  let send;
  if (args.includes("--fake")) {
    send = fakeJudge();
  } else {
    socket = modelSocket(process.env, { blocking: true });
    if (!socket?.covers("claude")) {
      throw new Error("the gold self-check runs only through the model socket (BENCH_MODEL_SOCKET with socketAnswerer.mjs, the Lab's cc mode, $0)");
    }
    send = socketSend(socket);
  }

  const report = await goldCheck(training, { send, model });
  assertAnswered(socket, "the gold self-check");

  const out = flag(args, "--out");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) await writeFile(out, json);
  else process.stdout.write(json);
  const failures = report.goldFails.length;
  process.stdout.write(`gold self-check: ${failures} of ${report.rows} Training labels fail their own gold (${report.skipped.length} skipped)\n`);
  for (const fail of report.goldFails) {
    for (const f of fail.failed) process.stdout.write(`GOLD FAIL ${fail.convId} ${fail.msgIndex}: ${f.kind} ${f.line} (${f.reason})\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
