/**
 * `pnpm ai jobs [--dir <folder with setups/texting-assistant/>] [--setup production] [--only a,b] [--max-parts 4]
 *   [--max-usd 5] [--json <rows>] [--out <records>] [--strict] [--fake]`
 *
 * TEX'S BACKGROUND JOBS, RUN END TO END AND GRADED IN CODE (Dev2, 2026-11-13: "are there any benchmarks for ...
 * whether the agents are getting tasks done right, like creating pages and doing research ... and evaluating it?").
 *
 * There were none: the conversation bench records the jobs a turn starts and runs none of them. Here each case in
 * `bench/job-tasks/cases.json` is one job, asked as the texting Worker asks it (`apps/agent/src/jobRun.ts` `ask`),
 * part after part, through the real gateway in a throwaway world (`world.mjs`) on the scripted web
 * (`bench/ai/sites/`), with production's done check after every part (`jobCheck.js`): a part the check says is not
 * finished is followed by another, on its advice, as the Worker does, up to `--max-parts` (production allows 10; the
 * bench stops at 4 to bound its cost). Then, in plain code:
 *
 *   - the page: a note it wrote under `page.under`, or the placed page at `page.at`, rewritten;
 *   - its sources: at least `sources.min` distinct links on `sources.hosts`;
 *   - every part of the ask: each `covers` entry in the page (`a|b` is either), no `absent` one;
 *   - a page edit keeps the placed lines named in `keeps`;
 *   - an errand's site step happened (`site`: the scripted browser's record, `sites.mjs`);
 *   - the job ended done, as the Worker would end it.
 *
 * A case is right when every check passes. A quality judge (Haiku, one call a case) then reads the page for what
 * code can't (`quality`), and its grades are reported beside the checks; they never decide a case.
 *
 * The setup is production's, pulled from Context (`pnpm ai pull texting-assistant`, then `--setup production`).
 * `--fake` runs a scripted model on a stand-in setup: it proves the plumbing and spends nothing.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { aiGatewayConfig, requestViaGateway } from "../src/agent/aiGateway.js";
import { benchFolder, REPO_BENCH_FOLDER } from "./folder.mjs";
import { readBenchFolder } from "./load.mjs";
import { priceUsd } from "./report.mjs";
import { readHeldOut } from "./replayGate.mjs";
import { readSetups, readSkills, setupInWorld } from "./run.mjs";
import { prepareRun } from "./warm.mjs";
import { assertAnswered, modelSocket, socketRequest, socketSend } from "./modelSocket.mjs";
import { cachedEmbeddings, fakeAi } from "./models.mjs";
import { benchModels } from "./worldModels.mjs";
import { createWorld } from "./world.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CASES = join(HERE, "job-tasks", "cases.json");
export const MAX_PARTS = 4;
export const MAX_USD = 5;
export const QUALITY_JUDGE = "anthropic/claude-haiku-5-5";

/** A stand-in setup for `--fake`: production's shape (the advisor on, so the done check runs), none of its words. */
export const FAKE_SETUP = {
  name: "fake",
  raw: "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n  advisor: anthropic/claude-opus-5-5\n---\n\nYou are a test assistant.\n",
  modules: [],
  model: "anthropic/claude-haiku-5-5",
};

export async function loadCases(path = CASES) {
  return JSON.parse(await readFile(path, "utf8")).cases;
}

/** How the Worker ends a job (`jobRun.ts`): waiting, stuck (said so, or not finished when its parts ran out), done, or failed. */
export function endedAs(parts) {
  const last = parts.at(-1);
  if (!last || !last.ok) return "failed";
  if (last.verdict === "waiting") return "waiting";
  if (last.verdict === "stuck" || last.verdict === "keep_going" || last.unfinished) return "stuck";
  return "done";
}

/** One job, part after part, as the Worker runs it: the next part on the check's advice while it says not finished. */
export async function runJob(world, item, { maxParts = MAX_PARTS } = {}) {
  let job = { id: `bench-${item.id}`, title: item.job.title, brief: item.job.brief, ...(item.job.doneWhen ? { doneWhen: item.job.doneWhen } : {}), asked: [item.text], attempt: 1 };
  const parts = [];
  for (let attempt = 1; attempt <= maxParts; attempt += 1) {
    const before = world.modelCalls?.().length ?? 0;
    const turn = await world.text(item.text, [], { job: { ...job, attempt } });
    // Whether production's done check was asked about this part: its brief ends "Is the job finished?" (`jobCheckBrief`).
    const checked = (world.modelCalls?.() ?? []).slice(before).some((call) => JSON.stringify(call.messages ?? []).includes("Is the job finished?"));
    parts.push({ attempt, checked, ok: turn.ok, error: turn.error, answer: turn.answer, verdict: turn.verdict ?? null, advice: turn.advice ?? "", unfinished: turn.unfinished === true, tools: turn.tools.map((call) => `${call.tool}${call.ok === false ? " (failed)" : ""}`), ms: turn.ms, usageByModel: turn.usageByModel ?? {} });
    if (!turn.ok) break;
    if (!(turn.verdict === "keep_going" || (turn.verdict === null && turn.unfinished))) break;
    // What the Worker keeps for the next part (`jobRun.ts`): this part's words as the draft, the check's advice.
    job = { ...job, draft: turn.answer, unfinished: true, ...(turn.advice ? { advice: turn.advice } : {}) };
  }
  return { parts, status: endedAs(parts) };
}

const lower = (text) => String(text ?? "").toLowerCase();
/** Whether a `covers` entry is in the text: any of its `|` alternatives. */
export const hasEntry = (text, entry) => entry.split("|").some((alt) => lower(text).includes(lower(alt.trim())));

/** The distinct links in a text on any of the hosts (or a subdomain), with or without their scheme. */
export function sourcesIn(text, hosts) {
  const found = new Set();
  for (const host of hosts) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const m of String(text ?? "").matchAll(new RegExp(`(?:https?://)?(?:[a-z0-9-]+\\.)*${escaped}(/[^\\s)\\]|>"'<]*)?`, "gi"))) {
      found.add(`${host}${(m[1] ?? "/").replace(/[.,;:!?]+$/, "").replace(/\/$/, "") || ""}`.toLowerCase());
    }
  }
  return [...found];
}

/**
 * The page a case is graded on: the placed page at `page.at` (only if the job rewrote it), else the written note
 * under `page.under` that covers most of the ask. `changes` are the world's (`world.changes()`), `read` a note's text.
 */
export function pickPage(item, changes, read, placed = {}) {
  const written = changes.filter((change) => change.kind === "written" && change.path.endsWith(".md") && !/^(tex|\.context)\//.test(change.path)).map((change) => `${change.workspace}/${change.path}`);
  if (item.page.at) {
    const path = item.page.at.slice(item.page.at.indexOf("/") + 1);
    const text = read(path);
    return text !== null && text !== placed[path] ? { path: item.page.at, text } : null;
  }
  const candidates = written.filter((path) => path.startsWith(item.page.under)).map((path) => ({ path, text: read(path.slice(path.indexOf("/") + 1)) ?? "" }));
  const score = (page) => (item.covers ?? []).filter((entry) => hasEntry(page.text, entry)).length;
  return candidates.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The plain-code checks on one run, each `{ line, pass }`. */
export function checkTask(item, { page, status, browser = [], parts = [] }) {
  const checks = [];
  checks.push({ line: item.page.at ? `rewrote ${item.page.at}` : `wrote a page under ${item.page.under}`, pass: page !== null });
  const text = page?.text ?? "";
  if (item.sources?.min) {
    const found = sourcesIn(text, item.sources.hosts);
    checks.push({ line: `cites ${item.sources.min}+ sources on ${item.sources.hosts.join(", ")} (found ${found.length})`, pass: found.length >= item.sources.min });
  }
  for (const entry of item.covers ?? []) checks.push({ line: `covers "${entry}"`, pass: hasEntry(text, entry) });
  for (const entry of item.absent ?? []) checks.push({ line: `no longer says "${entry}"`, pass: page !== null && !hasEntry(text, entry) });
  for (const line of item.keeps ?? []) checks.push({ line: `keeps "${line}"`, pass: text.includes(line) });
  for (const event of item.site ?? []) checks.push({ line: `site: ${event}`, pass: browser.some((seen) => lower(seen) === lower(event)) });
  checks.push({ line: `ended ${item.finish ?? "done"} (ended ${status})`, pass: status === (item.finish ?? "done") });
  // Production's done check read every part: a part it never saw was graded by the old phrase list alone.
  checks.push({ line: "the done check read every part", pass: parts.length > 0 && parts.every((part) => part.checked === true) });
  return checks;
}

export const QUALITY_PROMPT =
  "You grade one piece of work a texting assistant's background job left in a person's notes. Below are what they asked, " +
  "the page it wrote, and the job's last report. For each numbered criterion, answer one line: `<n>: PASS` or `<n>: FAIL - <why, a few words>`. " +
  "Judge only from what is written here; a criterion the page does not show is a FAIL. Answer nothing else.";

/** The judge's lines, by criterion: `{ criterion, pass, why }`; a criterion it skipped is a fail. */
export function readQuality(criteria, text) {
  return criteria.map((criterion, i) => {
    const m = new RegExp(`^\\s*${i + 1}\\s*[:.)-]\\s*(PASS|FAIL)\\b[\\s:-]*(.*)$`, "im").exec(String(text ?? ""));
    return { criterion, pass: m?.[1]?.toUpperCase() === "PASS", why: m ? m[2].trim().slice(0, 200) : "no grade" };
  });
}

/** One quality call; null when there is nothing to grade. */
export async function judgeQuality(item, { page, report }, request) {
  if (!page || !(item.quality ?? []).length) return { grades: [], usd: 0 };
  const message = `<asked>\n${item.text}\n</asked>\n\n<page path="${page.path}">\n${page.text.slice(0, 12_000)}\n</page>\n\n<report>\n${report}\n</report>\n\nCriteria:\n${item.quality.map((line, i) => `${i + 1}. ${line}`).join("\n")}`;
  const reply = await request({ model: QUALITY_JUDGE, system: QUALITY_PROMPT, messages: [{ role: "user", text: message }], tools: [], maxTokens: 400 });
  return { grades: readQuality(item.quality, reply?.text), usd: priceUsd(QUALITY_JUDGE, reply?.usage ?? {}) ?? 0 };
}

/** A stand-in quality judge for `--fake`: fails every criterion, so nothing reads as graded. */
const fakeQuality = async () => ({ text: "", usage: {} });

/** What a job's parts cost, priced model by model. */
export const partsUsd = (parts) => parts.reduce((sum, part) => sum + Object.entries(part.usageByModel ?? {}).reduce((s, [model, usage]) => s + (priceUsd(model, usage) ?? 0), 0), 0);

/** The replay gate's row for a graded case (`replayGate.mjs`): right and expected are this scorer's own. */
export const gateRow = (record) => ({ id: record.id, right: record.right === true, must: false, heldOut: record.heldOut === true, target: record.target ?? false, cause: record.cause ?? (record.target || null), expected: expectedOf(record), usd: record.usd ?? 0 });

/** What the gate's report says a case expected: for a practice case, the checks it failed too; a held-out one, nothing more. */
function expectedOf(record) {
  const failed = record.heldOut === true ? [] : (record.checks ?? []).filter((check) => !check.pass).map((check) => check.line);
  return `finish with every check passing${failed.length ? ` (failed: ${failed.join("; ")})` : ""}`;
}

/** Whether the jobs clear the bar: every case that is not a target right. */
export const passes = (records) => records.filter((record) => !record.target).every((record) => record.right);

export function jobsReport(records) {
  const graded = records.filter((record) => !record.target);
  const targets = records.filter((record) => record.target);
  const usd = records.reduce((sum, record) => sum + record.usd, 0);
  const grades = records.flatMap((record) => record.quality);
  const lines = [
    `## Job tasks ${passes(records) ? "✅ pass" : "❌ below the bar"}`,
    "",
    "Bar: every task's plain-code checks pass (a target, a bug not fixed yet, is reported and never counts against it). Quality is graded beside, never deciding.",
    "",
    `**Tasks:** ${graded.filter((record) => record.right).length}/${graded.length} right. **Targets:** ${targets.filter((record) => record.right).length}/${targets.length} pass now. **Quality:** ${grades.filter((grade) => grade.pass).length}/${grades.length} criteria. Spent about $${usd.toFixed(2)}.`,
    "",
    "| task | kind | checks | ended | parts | quality | time | cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...records.map((record) => `| ${record.target ? "🎯 " : ""}${record.id} | ${record.kind} | ${record.right ? "✅" : "❌"} ${record.checks.filter((check) => check.pass).length}/${record.checks.length} | ${record.status} | ${record.parts.length} | ${record.quality.filter((grade) => grade.pass).length}/${record.quality.length} | ${(record.ms / 1000).toFixed(0)} s | $${record.usd.toFixed(2)} |`),
    "",
  ];
  for (const record of records.filter((r) => !r.right || r.quality.some((grade) => !grade.pass))) {
    lines.push(`**${record.id}**${record.page ? ` (page \`${record.page.path}\`)` : " (no page)"}${record.error ? `: ${record.error}` : ""}`);
    for (const check of record.checks.filter((c) => !c.pass)) lines.push(`- ❌ ${check.line}`);
    for (const grade of record.quality.filter((g) => !g.pass)) lines.push(`- quality ❌ ${grade.criterion}: ${grade.why}`);
    for (const part of record.parts) lines.push(`- part ${part.attempt}: ${part.verdict ?? (part.ok ? "no verdict" : `failed: ${part.error}`)}${part.advice ? `, advised "${part.advice.slice(0, 160)}"` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Grade one finished job in its world. */
async function gradeJob(world, item, ran, request, placed) {
  const page = pickPage(item, world.changes(), (path) => world.read(path), placed);
  const browser = world.browser();
  const checks = checkTask(item, { page, status: ran.status, browser, parts: ran.parts });
  const report = ran.parts.at(-1)?.answer ?? "";
  const quality = await judgeQuality(item, { page, report }, request).catch(() => ({ grades: item.quality.map((criterion) => ({ criterion, pass: false, why: "the judge failed" })), usd: 0 }));
  return { page, checks, quality, browser, report };
}

export async function jobTasksCommand(options, { write = (text) => process.stdout.write(text) } = {}) {
  const config = aiGatewayConfig(process.env);
  // A prompt-fingerprint run (`modelSocket.mjs` FINGERPRINT_ENV, `promptFingerprint.mjs`) hashes every Claude call and
  // answers it with stand-in words: no key, nothing spent, and the quality grade is the stand-in's too.
  const socket = options.fake ? null : modelSocket(process.env, { blocking: true });
  const fingerprint = socket?.mode === "fingerprint";
  // Through the model socket an examiner session answers every Claude call, the quality judge's included, and CI
  // replays the run from those answers alone (Dev2, 2026-11-13, no API credits; 2026-11-14: every config change now
  // reaches every area's prompts, jobs' too, since what Tex is told about itself is the config's).
  const socketed = socket !== null && socket.covers("claude");
  if (!options.fake && !socketed && config === null) throw new Error("set AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN");
  const bench = await readBenchFolder(REPO_BENCH_FOLDER);
  const setupsDir = benchFolder(options);
  const setupName = options.setup ?? "production";
  const setup = options.fake ? FAKE_SETUP : (await readSetups(setupsDir, "texting-assistant", [setupName]))[0];
  const skills = options.fake ? [] : await readSkills(setupsDir, "texting-assistant");
  const only = options.only ? new Set(String(options.only).split(",")) : null;
  const cases = [...(await loadCases()), ...(await readHeldOut(options["held-out"], "jobs"))].filter((item) => !only || only.has(item.id));
  const maxParts = Number(options["max-parts"] ?? MAX_PARTS);
  const maxUsd = Number(options["max-usd"] ?? MAX_USD);
  const models = { ...benchModels(options, { scripted: true, sites: bench.sites, ...(socketed ? { send: socketSend(socket) } : {}) }), skills };
  // Workers AI (embeddings, Clef) answers with the scripted stand-in, as a socketed run's does (`run.mjs`): a real model's
  // numbers would change what a turn reads, and so its prompts.
  if (socketed) models.ai = cachedEmbeddings(fakeAi());
  const request = options.fake || fingerprint ? fakeQuality : socketed ? socketRequest(socket) : (params) => requestViaGateway(params, config, { metadata: { feature: "bench", client: "job-tasks" } });
  const records = [];
  let spent = 0;
  for (const item of cases) {
    const record = { id: item.id, kind: item.kind, target: item.target ?? false, heldOut: item.heldOut === true, cause: item.cause ?? null, parts: [], status: "not run", page: null, checks: [], quality: [], usd: 0, ms: 0, error: null };
    if (spent >= maxUsd) {
      records.push({ ...record, error: `not run: the run reached its $${maxUsd} cap`, checks: [{ line: "ran", pass: false }] });
      continue;
    }
    const prepared = options.cold ? null : await prepareRun(bench, { today: item.today ?? null, ai: models.ai });
    const [worldSetup, worldModels] = setupInWorld("texting-assistant", setup, models);
    const world = await createWorld(bench, item.as, worldSetup, worldModels, item.today ?? null, prepared);
    const started = Date.now();
    try {
      for (const [path, body] of Object.entries(item.places ?? {})) world.place(path, body);
      const ran = await runJob(world, item, { maxParts });
      const graded = await gradeJob(world, item, ran, request, item.places ?? {});
      record.parts = ran.parts;
      record.status = ran.status;
      record.page = graded.page;
      record.checks = graded.checks;
      record.quality = graded.quality.grades;
      record.browser = graded.browser;
      record.usd = partsUsd(ran.parts) + graded.quality.usd;
      record.error = ran.parts.find((part) => !part.ok)?.error ?? null;
    } catch (error) {
      record.error = String(error?.message ?? error);
      record.checks = [{ line: "ran", pass: false }];
    } finally {
      record.ms = Date.now() - started;
      world.close();
      prepared?.close();
    }
    record.right = record.checks.length > 0 && record.checks.every((check) => check.pass);
    spent += record.usd;
    records.push(record);
    process.stderr.write(`${item.id}: ${record.right ? "right" : "wrong"}, ended ${record.status} after ${record.parts.length} part(s), $${record.usd.toFixed(2)}\n`);
  }
  for (const record of records) record.right ??= false;
  // A call the examiner never answered fails the run rather than score the path the code fell back to.
  if (socketed && !fingerprint) assertAnswered(socket, "the jobs run");
  // A held-out case's words never reach the report: it counts, and is named by its cause alone.
  const held = records.filter((record) => record.heldOut);
  const heldWrong = held.filter((record) => !record.right);
  write(`${jobsReport(records.filter((record) => !record.heldOut))}\n${held.length ? `Held-out: ${held.length - heldWrong.length}/${held.length} right${heldWrong.length ? `; wrong about ${[...new Set(heldWrong.map((record) => record.cause))].join(", ")}` : ""}.\n` : ""}`);
  if (options.json) await writeFile(options.json, JSON.stringify(records.map(gateRow)));
  if (options.out) await writeFile(options.out, JSON.stringify(records.filter((record) => !record.heldOut), null, 1));
  if (options.strict === true && !passes(records)) process.exitCode = 1;
  return records;
}
