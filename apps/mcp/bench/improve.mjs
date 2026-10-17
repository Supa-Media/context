/**
 * `pnpm ai improve <result file> [--setup production] [--model <model>] [--max-usd <n>] [--publish] [--fake]`
 *
 * The step after a scored round: read where one setup failed, and draft ONE
 * experiment that might fix it, in the production file's format, beside the
 * setups in `setups/<job>/`. It never promotes and never starts a round: a
 * person runs the draft against live (the Action's `improve: draft and test`
 * is that person asking) and decides from the scores. Decided by the owner on
 * 2026-10-16 ("the improver never promotes, and an AI starts a bench round
 * only when a person asks") and 2026-10-17 (a loop that says how to improve
 * when a golden task fails: "editing the prompt or changing the model").
 *
 * What the improver is shown: the setup's whole file, its row of scores
 * against the test's bars (price, speed and texts too, so a cheaper model is a
 * fair proposal when everything passes but the price), and every failing run
 * of every case it failed: the case, the lines that failed with the judge's
 * reason, the texts, the tools and the recorded changes. The fixtures are
 * invented people, so this quotes nobody's real notes; it still never leaves
 * the runner except to the model.
 *
 * What it may do: edit the file by exact find-and-replace, the front matter
 * included, so a model change and a prompt change are the same kind of edit.
 * What it may not do, checked here and sent back to the model to try again:
 * an edit whose text is not in the file exactly once, a file the gateway would
 * refuse (`parseSetup`), no change at all, or a capitalised name from the test
 * the setup never used (a person, a place, a venue): a prompt that names the
 * test's people is written for the test, which the owner ruled out on
 * 2026-10-10 ("we want a general sense of intelligence here").
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { parseSetup } from "../src/agent/production.js";
import { parseTest } from "./load.mjs";
import { claudeTransport } from "./models.mjs";
import { priceUsd } from "./report.mjs";
import { frontMatter, parseJudgedSections, parseKey, parseResult } from "./resultNote.mjs";
import { parseBars, scoreSetups } from "./score.mjs";
import { benchFolder } from "./folder.mjs";

/** The model that drafts, unless --model names another. A draft is one call; the smart model is worth it. */
export const DEFAULT_IMPROVER = "claude-opus-5-5";
/** The most a draft may be estimated to cost without --max-usd raising it. */
export const DEFAULT_MAX_USD = 1;
/** How many times the model is asked again after a draft that cannot be used. */
export const IMPROVE_ATTEMPTS = 3;
/** Failing runs shown per case: one per distinct set of failed lines is enough to see the pattern. */
const RUNS_PER_CASE = 2;
const MAX_TOKENS = 8000;
const CHARS_PER_TOKEN = 4;

const SYSTEM = [
  "You improve the setup of an AI job: a Markdown file whose front matter names the models and settings, and whose body is the whole prompt.",
  "You are shown the setup, how it scored against the test's bars, and every case it failed with the lines that failed, the judge's reason, the conversation, the tools it called and what it changed.",
  "Propose ONE change most likely to fix the most failures without breaking what passes: an edit to the prompt, or a change of model or setting in the front matter (main, think, route_at, effort, fallback, max_steps).",
  "Fix the cause, never the case: write general guidance a capable assistant would follow for every person, and never a case's answer, a person's or a place's name from the cases, or a question's wording.",
  "Prefer the smallest edit that does it. Keep the prompt's own voice and structure. A model change costs money and time: weigh the price and speed bars you are shown.",
  "Every edit is an exact find and replace on the file: find must be text copied exactly from the file, appearing exactly once, and replace is what takes its place.",
  "Reply with JSON only, in the shape the schema gives: a short title (under 60 characters), change (one sentence saying what you changed), why (one sentence naming the failures it should fix), and the edits.",
].join(" ");

/** The draft's shape, held to by the API (structured outputs), as the judge's is. */
export const IMPROVE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    change: { type: "string" },
    why: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: { find: { type: "string" }, replace: { type: "string" } },
        required: ["find", "replace"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "change", "why", "edits"],
  additionalProperties: false,
};

/** A failed line counts the way the score counts it: a judge line never fails a case. */
const failedLines = (verdict) => verdict.verdicts.filter((v) => !v.pass && v.kind !== "judge");

/**
 * The cases `setup` failed, each with up to RUNS_PER_CASE failing runs: the
 * lines that failed and why, the conversation, the tools and the changes.
 * A run the model never answered is shown as its error, since an unanswered
 * golden task fails too. Never an answer id.
 */
export function failuresOf({ setup, key, judged, answers, questions }) {
  const byCase = new Map();
  for (const row of key) {
    if (row.setup !== setup) continue;
    const verdict = judged.get(row.id);
    const answer = answers.get(row.id);
    const q = questions.get(row.question);
    if (!verdict || !answer || !q) continue;
    const broken = verdict.skipped ? [] : failedLines(verdict);
    if (!verdict.skipped && broken.length === 0) continue;
    if (verdict.skipped && q.kind !== "task") continue;
    const runs = byCase.get(row.question) ?? [];
    if (runs.length >= RUNS_PER_CASE) continue;
    runs.push({
      run: row.run,
      error: verdict.skipped ?? null,
      failed: broken.map((v) => ({ kind: v.kind, line: v.line, reason: v.reason })),
      conversation: answer.conversation,
      tools: answer.toolsLine ?? null,
      changes: answer.changes ?? [],
    });
    byCase.set(row.question, runs);
  }
  return [...byCase.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, runs]) => {
      const q = questions.get(n);
      return { case: n, question: q.text, as: q.as, kind: q.kind, must: q.must, must_not: q.mustNot, runs };
    });
}

const MONTHS_AND_DAYS = new Set("January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split(" "));

/**
 * The capitalised words a test uses mid-sentence (a person, a place, a
 * venue): the words a prompt written for the test would carry. The first word
 * of a sentence, a month or a weekday is not one.
 */
export function testNames(questions) {
  const names = new Set();
  for (const q of questions) {
    for (const text of [q.text, q.body, ...q.must, ...q.mustNot, ...q.may]) {
      for (const sentence of String(text ?? "").split(/[.!?:\n]+/)) {
        const words = sentence.trim().split(/\s+/).slice(1);
        for (const word of words) {
          const bare = word.replace(/['’]s$/, "").replace(/[^A-Za-z]/g, "");
          if (/^[A-Z][a-z]{2,}$/.test(bare) && !MONTHS_AND_DAYS.has(bare)) names.add(bare);
        }
      }
    }
  }
  return names;
}

/**
 * `base` with `edits` applied, or the reason it cannot be: an edit whose find
 * is not in the file exactly once, a name from the test the setup never used,
 * or no change at all. `parseSetup` is checked by the caller (it is async).
 */
export function applyEdits(base, edits, names = new Set()) {
  if (!Array.isArray(edits) || edits.length === 0) return { error: "the draft has no edits" };
  let text = base;
  for (const [i, edit] of edits.entries()) {
    const find = String(edit?.find ?? "");
    if (find === "") return { error: `edit ${i + 1} has an empty find` };
    const at = text.indexOf(find);
    if (at === -1) return { error: `edit ${i + 1}'s find is not in the file: copy it exactly` };
    if (text.indexOf(find, at + 1) !== -1) return { error: `edit ${i + 1}'s find appears more than once: include more of the line around it` };
    text = text.slice(0, at) + String(edit.replace ?? "") + text.slice(at + find.length);
  }
  if (text === base) return { error: "the edits change nothing" };
  const used = [...names].filter((name) => new RegExp(`\\b${name}\\b`).test(text) && !new RegExp(`\\b${name}\\b`).test(base));
  if (used.length) return { error: `the draft names ${used.join(", ")} from the test's cases: write general guidance, never the test's people or places` };
  return { text };
}

/** The Messages API body for a draft: the setup, its scores and its failures. */
export function buildImproveRequest({ model, setupName, setupRaw, row, bars, failures }) {
  const payload = {
    setup: setupName,
    scores: row && {
      score: row.score,
      gates_failed: row.gateFailed,
      voice: row.voice,
      price_per_question_usd: row.price,
      median_seconds: row.speed,
      texts_per_question: row.texts,
      errors: row.errors,
    },
    bars,
    failures,
  };
  const content = ["<setup>", setupRaw, "</setup>", "", "<round>", JSON.stringify(payload, null, 2), "</round>", "", "Draft one change."].join("\n");
  return {
    messages: [{ role: "user", content }],
    body: (messages) => JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM, messages, output_config: { format: { type: "json_schema", schema: IMPROVE_SCHEMA } } }),
    inputTokens: Math.ceil((SYSTEM.length + content.length) / CHARS_PER_TOKEN),
  };
}

/** The price per million tokens is keyed by bare model id or provider-prefixed name. */
const priceOf = (model, usage) => priceUsd(model, usage) ?? priceUsd(`anthropic/${model}`, usage);

/** What a draft will cost at most: every attempt reading the request and writing max_tokens. */
export function estimateDraft(inputTokens, model) {
  return priceOf(model, { input: inputTokens * IMPROVE_ATTEMPTS, output: MAX_TOKENS * IMPROVE_ATTEMPTS });
}

/** A scripted improver for `--fake`: one line added after the prompt's first line, and nothing spent. */
export function fakeImprover(setupRaw) {
  const body = setupRaw.replace(/^---\n[\s\S]*?\n---\n/, "");
  const first = body.split("\n").find((line) => line.trim() !== "" && setupRaw.split(line).length === 2);
  return async () => ({
    title: "Say the answer first",
    change: "Adds a line telling the assistant to give the answer before anything else.",
    why: "A scripted draft: --fake spends nothing.",
    edits: first ? [{ find: first, replace: `${first}\n\nGive the answer first, then at most one line of context.` }] : [],
  });
}

/**
 * Ask the model for a draft, and ask again with the reason when it cannot be
 * used, up to IMPROVE_ATTEMPTS times. Returns `{ draft, text, usage }`.
 */
export async function draftWith({ ask, request, setupRaw, names }) {
  const messages = [...request.messages];
  const usage = { input: 0, output: 0 };
  let last = "no attempt was made";
  for (let attempt = 1; attempt <= IMPROVE_ATTEMPTS; attempt += 1) {
    const { draft, reply, used } = await ask(messages);
    usage.input += used?.input ?? 0;
    usage.output += used?.output ?? 0;
    const applied = draft ? applyEdits(setupRaw, draft.edits, names) : { error: "the reply was not the draft's JSON" };
    if (applied.text !== undefined && !(await parseSetup(applied.text))) applied.error = "the edited file is not a setup the gateway can read (a model it does not know, a broken front matter line, or a prompt over 1,000 lines)";
    if (!applied.error) return { draft, text: applied.text, usage };
    last = applied.error;
    if (reply) messages.push({ role: "assistant", content: reply });
    messages.push({ role: "user", content: `That draft cannot be used: ${applied.error}. Send the whole draft again.` });
  }
  throw new Error(`no usable draft after ${IMPROVE_ATTEMPTS} attempts: ${last}`);
}

/** One call to the model through the bench's transport, as `draftWith` asks it. */
export function modelAsker(send, request) {
  return async (messages) => {
    const response = await send(request.body(messages));
    if (!response.ok) {
      const reply = await response.json().catch(() => ({}));
      throw new Error(`improver call failed: status ${response.status}${reply?.error?.message ? ` (${reply.error.message})` : ""}`);
    }
    const reply = await response.json();
    const text = (reply.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
    let draft = null;
    try {
      draft = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {
      draft = null;
    }
    return { draft, reply: text, used: { input: reply.usage?.input_tokens ?? 0, output: reply.usage?.output_tokens ?? 0 } };
  };
}

// Front matter that says how live got there, or what an earlier experiment
// tried: never carried into a new experiment (the AI tab's `NOT_COPIED`).
const NOT_COPIED = new Set(["from", "live_since", "promoted_by", "came_from", "why", "status", "made_by", "based_on", "change", "title", "job"]);
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * The experiment note, in the shape the AI tab writes a new experiment
 * (`apps/mobile/features/admin/aiExperiments.ts`): the edited file with the
 * bookkeeping of how live got there taken out, and `title`, `based_on`,
 * `change`, `why` and `made_by` set, so Compare shows the one change.
 */
export function experimentNote(text, { job, basedOn, draft, by }) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const lines = match[1].split("\n");
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const key = line.match(/^([a-z_][a-z0-9_-]*):/)?.[1];
    if (key) skipping = NOT_COPIED.has(key);
    else if (!/^\s/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  const title = oneLine(draft.title).slice(0, 60);
  return [
    "---",
    `job: ${job}`,
    ...kept,
    `title: ${title}`,
    `based_on: ${basedOn}`,
    `change: ${oneLine(draft.change)}`,
    `why: ${oneLine(draft.why)}`,
    `made_by: ${by}`,
    "---",
    text.slice(match[0].length).replace(/^\n?/, "\n"),
  ].join("\n");
}

/** The draft's note name: its title's first five words, never one already taken (the AI tab's rule). */
export function draftName(title, taken) {
  const words = String(title).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const base = words.slice(0, 5).join("-").slice(0, 48).replace(/-+$/, "") || "experiment";
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

/**
 * Draft one experiment from a scored result. Returns `null` when the setup
 * failed nothing and met every bar: there is nothing to improve, and nothing
 * is spent. Otherwise writes `setups/<job>/<name>.md` and returns its name.
 */
export async function improveFile({ path, dir, setup = null, model = DEFAULT_IMPROVER, maxUsd = DEFAULT_MAX_USD, fake = false, send = null, log = (line) => process.stderr.write(`${line}\n`) }) {
  const raw = await readFile(path, "utf8");
  const front = frontMatter(raw);
  if (!front.test || !front.key || !front.job) throw new Error(`${path} needs job:, test: and key: in its front matter`);
  const sections = parseJudgedSections(raw);
  if (sections.length === 0) throw new Error(`${path} has not been judged; run pnpm ai judge and score first`);
  const key = parseKey(await readFile(join(dirname(path), front.key), "utf8"));
  const answers = new Map(parseResult(raw).answers.map((answer) => [answer.id, answer]));
  const test = parseTest(await readFile(join(dir, "tests", `${front.test}.md`), "utf8"));
  const questions = new Map(test.questions.map((q) => [q.n, q]));
  const judged = sections.at(-1).blocks;
  const ran = [...new Set(key.map((row) => row.setup))];
  const base = setup ?? (ran.includes("production") ? "production" : ran[0]);
  if (!ran.includes(base)) throw new Error(`setup ${base} did not run in ${basename(path)} (it ran ${ran.join(", ")})`);

  const bars = parseBars(test.front.good_enough);
  const { rows } = scoreSetups({ key, judged, answers, questions, bars });
  const row = rows.find((r) => r.setup === base);
  const failures = failuresOf({ setup: base, key, judged, answers, questions });
  if (failures.length === 0 && row.goodEnough) {
    log(`${base} passed every case and every bar: nothing to improve.`);
    return null;
  }

  const folder = join(dir, "setups", front.job);
  const setupRaw = await readFile(join(folder, `${base}.md`), "utf8");
  const request = buildImproveRequest({ model, setupName: base, setupRaw, row, bars: test.front.good_enough ?? {}, failures });
  const estimate = estimateDraft(request.inputTokens, model);
  log(`Drafting from ${failures.length} failed case(s) of ${base} with ${fake ? "a scripted improver" : model}; at most ${estimate === null ? "an unknown price" : `$${estimate.toFixed(2)}`}.`);
  if (!fake && (estimate === null || estimate > maxUsd)) throw new Error(`a draft could cost ${estimate === null ? "an unknown amount" : `$${estimate.toFixed(2)}`}, over --max-usd ${maxUsd}: raise it on purpose`);

  const ask = fake ? async () => ({ draft: await fakeImprover(setupRaw)(), reply: null, used: null }) : modelAsker(send ?? claudeTransport(process.env), request);
  const { draft, text, usage } = await draftWith({ ask, request, setupRaw, names: testNames(test.questions) });

  const taken = new Set((await readdir(folder)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)));
  const name = draftName(draft.title, taken);
  const by = `improver (${fake ? "scripted" : model}, from ${basename(path, ".md")})`;
  await writeFile(join(folder, `${name}.md`), experimentNote(text, { job: front.job, basedOn: base, draft, by }));
  const spent = fake ? 0 : priceOf(model, usage);
  log(`Drafted ${name}: ${oneLine(draft.change)} (${spent === null ? "price unknown" : `$${spent.toFixed(4)}`}).`);
  return name;
}

/** The `improve` command: prints the draft's name on stdout, or nothing when there is nothing to improve. */
export async function improveCommand(options, { publish = null } = {}) {
  const dir = benchFolder(options);
  if (!options.job || !dir) throw new Error("usage: pnpm ai improve <result file> [--setup <name>] [--model <model>] [--max-usd <n>] [--publish] [--fake]");
  const name = await improveFile({
    path: options.job,
    dir,
    setup: options.setup ?? null,
    model: options.model ?? DEFAULT_IMPROVER,
    maxUsd: options["max-usd"] === undefined ? DEFAULT_MAX_USD : Number(options["max-usd"]),
    fake: options.fake === true,
  });
  if (name === null) return;
  if (options.publish && publish) {
    const job = frontMatter(await readFile(options.job, "utf8")).job;
    const written = await publish({ job, name, file: join(dir, "setups", job, `${name}.md`) });
    process.stderr.write(`Wrote ${written} in Context.\n`);
  }
  process.stdout.write(`${name}\n`);
}
