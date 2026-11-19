/**
 * THE KEPT FRONT DOOR CASES, GRADED AGAIN (Dev2, 2026-11-19: "is the judge the same twice?"). A Front door test kept by
 * `sets run --keep <dir>` is a folder with its judged result, its key and its test (`coreArea.mjs` keepJudged), and
 * `units.json` (`setsFd.mjs`): the chat, message and node of each question. `sets regrade --kept <dir>` judges each
 * kept result again, `times` times, each a fresh copy of the unjudged answers, under its own salt (`judgeFile`'s
 * `salt`, so the judge's identical calls are not one cached answer), with `votes` votes a line. The original grade is
 * read from the kept judgment as it stands. A case whose grades differ is a flip: the judge, not Tex, moved.
 *
 *   node apps/mcp/bench/run.mjs sets regrade --kept <dir> [--times 3] [--votes 3] [--out <file.json>] [--fake]
 *
 * Standard output says counts and ids with their grades, never a message's words; the full rows (lines and their
 * passes) go to `--out`.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { caseId, coreCases } from "./coreArea.mjs";
import { DEFAULT_JUDGE, DEFAULT_VOTES, fakeJudge, judgeFile, labJudge } from "./judge.mjs";
import { claudeTransport } from "./models.mjs";
import { assertAnswered, modelSocket, socketSend } from "./modelSocket.mjs";
import { frontMatter } from "./resultNote.mjs";

/** The three notes a kept folder holds. */
const KEPT = ["result.md", "key.md", "test.md"];
/** The judged section's heading: a kept result is judged, and its judgment is what the original grade is read from. */
const JUDGED = /^## Judged by /m;

/** The kept folders under `kept` that hold all three notes, by name, in name order. */
export async function keptFolders(kept) {
  const entries = (await readdir(kept, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const out = [];
  for (const name of entries) {
    const folder = join(kept, name);
    const present = await Promise.all(KEPT.map((file) => stat(join(folder, file)).then(() => true, () => false)));
    if (present.every(Boolean)) out.push({ name, folder });
  }
  return out;
}

/** A kept folder's units.json rows, or none when it has none (a core test keeps no units). */
async function unitsOf(folder) {
  const raw = await readFile(join(folder, "units.json"), "utf8").catch(() => null);
  return raw === null ? [] : JSON.parse(raw);
}

/**
 * Each case's grade and each line's pass, from one judged result: `n` -> { right, lines: Map(key -> pass) }, where a
 * line's key is its kind and words. `coreCases` lists a row's held lines and its misses apart; a line that missed in
 * any of the row's runs did not pass.
 */
function gradesOf(rows) {
  const byCase = new Map();
  for (const row of rows) {
    const n = caseId(row.id)?.n;
    if (n === undefined) continue;
    const lines = new Map();
    for (const v of row.held ?? []) lines.set(`${v.kind}\n${v.line}`, true);
    for (const v of row.misses ?? []) lines.set(`${v.kind}\n${v.line}`, false);
    byCase.set(n, { right: row.right, lines });
  }
  return byCase;
}

/**
 * The kept folder's cases, each judged `times` more times: `[original, r1..rK]` grades per case, and per line the pass
 * in each. Returns one row per case: { id, chat, msg, node, grades, lines: [{ kind, line, passes }] }, where a grade or
 * pass the grading did not give is null.
 */
export async function regradeFolder({ name, folder }, { times, votes, send, log = () => {}, maxUsd }) {
  const resultRaw = await readFile(join(folder, "result.md"), "utf8");
  const keyRaw = await readFile(join(folder, "key.md"), "utf8");
  const testRaw = await readFile(join(folder, "test.md"), "utf8");
  const { test, key } = frontMatter(resultRaw);
  if (!test || !key) throw new Error(`${name}: the kept result has no test: or key: line in its front matter`);
  const unjudged = resultRaw.split(JUDGED)[0];
  const units = await unitsOf(folder);
  const grades = [gradesOf(coreCases({ test, testRaw, resultRaw, keyRaw }).rows)];
  for (let r = 1; r <= times; r += 1) {
    const tmp = await mkdtemp(join(tmpdir(), "tex-regrade-"));
    try {
      await mkdir(join(tmp, "tests"));
      await mkdir(join(tmp, "results"));
      const path = join(tmp, "results", "result.md");
      await writeFile(path, unjudged);
      await writeFile(join(tmp, "results", key), keyRaw);
      await writeFile(join(tmp, "tests", `${test}.md`), testRaw);
      await judgeFile({ path, dir: tmp, send, model: labJudge(DEFAULT_JUDGE), votes, maxUsd, salt: `regrade ${r}`, log });
      const judged = await readFile(path, "utf8");
      grades.push(gradesOf(coreCases({ test, testRaw, resultRaw: judged, keyRaw }).rows));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  const cases = new Set(grades.flatMap((g) => [...g.keys()]));
  if (cases.size === 0) throw new Error(`${name}: the kept result judges no case of the production setup`);
  const rows = [];
  for (const n of [...cases].sort((a, b) => a - b)) {
    const seen = grades.map((g) => g.get(n) ?? null);
    const lineKeys = [...new Set(seen.flatMap((g) => (g ? [...g.lines.keys()] : [])))];
    const unit = units[n - 1] ?? {};
    rows.push({
      id: `${name}/q${n}`,
      ...(unit.chat !== undefined ? { chat: unit.chat } : {}),
      ...(unit.msg !== undefined ? { msg: unit.msg } : {}),
      ...(unit.node !== undefined ? { node: unit.node } : {}),
      grades: seen.map((g) => (g ? g.right : null)),
      lines: lineKeys.map((k) => {
        const [kind, ...rest] = k.split("\n");
        return { kind, line: rest.join("\n"), passes: seen.map((g) => (g && g.lines.has(k) ? g.lines.get(k) : null)) };
      }),
    });
  }
  return rows;
}

/**
 * Every kept folder under `kept`, regraded: the case rows of all of them, in folder order. `send` is a judge transport
 * (`claudeTransport`, the socket's, or `fakeJudge`).
 */
export async function regradeKept({ kept, times = 3, votes = DEFAULT_VOTES, send, log = () => {}, maxUsd }) {
  const rows = [];
  for (const folder of await keptFolders(kept)) rows.push(...(await regradeFolder(folder, { times, votes, send, log, maxUsd })));
  return rows;
}

/** Whether a line's passes disagree: some grading passed it and another failed it. */
const flipped = (passes) => passes.includes(true) && passes.includes(false);

/**
 * The report over regraded rows: how many cases held every grading (stable pass), failed every grading (stable fail), or
 * flipped between them, with the flip rate over the cases that were graded at all, and each flipped case's lines that
 * flipped. `grades` reads as P (passed) / F (failed) / - (not graded), the original first.
 */
export function flipReport(rows) {
  let stablePass = 0;
  let stableFail = 0;
  const flippedRows = [];
  for (const row of rows) {
    const seen = row.grades.filter((g) => g !== null);
    const yes = seen.some(Boolean);
    const no = seen.some((g) => !g);
    if (yes && no) {
      flippedRows.push({
        id: row.id,
        ...(row.chat !== undefined ? { chat: row.chat } : {}),
        ...(row.msg !== undefined ? { msg: row.msg } : {}),
        ...(row.node !== undefined ? { node: row.node } : {}),
        grades: gradeString(row.grades),
        lines: row.lines.filter((l) => flipped(l.passes)),
      });
    } else if (yes) stablePass += 1;
    else if (no) stableFail += 1;
  }
  const graded = stablePass + stableFail + flippedRows.length;
  return {
    rows,
    stable_pass: stablePass,
    stable_fail: stableFail,
    flipped: flippedRows.length,
    flipRate: graded === 0 ? 0 : flippedRows.length / graded,
    flippedRows,
  };
}

/** `PFP`-style grades: P passed, F failed, - not graded. */
export const gradeString = (grades) => grades.map((g) => (g === null ? "-" : g ? "P" : "F")).join("");

/** A whole number in [min, max] from an option, or the error that names it. */
function whole(value, min, max, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}, got "${value}"`);
  return n;
}

/** `sets regrade`: the CLI half. Counts and ids on standard output; the full rows to `--out`. */
export async function regradeCommand(options, { write = (t) => process.stdout.write(t) } = {}) {
  if (!options.kept) throw new Error("usage: sets regrade --kept <dir> [--times n] [--votes n] [--out <file.json>] [--fake]");
  const times = options.times === undefined ? 3 : whole(options.times, 1, 9, "times");
  const votes = options.votes === undefined ? DEFAULT_VOTES : whole(options.votes, 1, 9, "votes");
  const kept = resolve(options.kept);
  let send;
  let socket = null;
  if (options.fake) send = fakeJudge();
  else {
    // The judge's transport as the judge command takes it (`judge.mjs`): the model socket when it covers Claude.
    socket = modelSocket(process.env, { blocking: true });
    send = socket?.covers("claude") ? socketSend(socket) : claudeTransport(process.env);
  }
  const rows = await regradeKept({ kept, times, votes, send, log: (line) => process.stderr.write(`${line}\n`) });
  if (socket) assertAnswered(socket, "the judge");
  const report = flipReport(rows);
  if (options.out) await writeFile(resolve(options.out), JSON.stringify(report, null, 1) + "\n");
  const pct = Math.round(report.flipRate * 100);
  write(`regrade: ${rows.length} rows, ${report.stable_pass} stable pass, ${report.stable_fail} stable fail, ${report.flipped} flip (${pct}%)\n`);
  for (const r of report.flippedRows) write(`FLIP ${r.id} ${r.grades}\n`);
  return report;
}
