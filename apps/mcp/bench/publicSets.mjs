/**
 * THE PUBLIC MEMORY BENCHMARKS AS A SEARCH BENCH FOLDER.
 *
 * Asked for by the owner (2026-11-13): an eval for Context on the benchmarks
 * the agent-memory companies report, LongMemEval and LoCoMo, before an eval
 * on our own data and one for Tex. This writes a bench folder that
 * `pnpm ai search --dir <out>` runs unchanged: each chat session is one note
 * in `inbox/sessions/`, where Context files a saved chat (so the log prior in
 * `search/priors.js` applies as it would in production), and each question
 * expects the session notes its dataset marks as holding the answer.
 *
 *   node bench/publicSets.mjs <out-dir> [--lme 30] [--locomo 10]   (writes <out-dir>/lme and <out-dir>/locomo)
 *
 * The datasets are downloaded at run time and never committed: the bench
 * folder in the repository is invented-only (`ai/README.md`).
 *
 * - LongMemEval-S cleaned (MIT): every question has its own haystack, so one
 *   question is one workspace and one person. Abstention questions (`_abs`)
 *   have no answer session and are skipped. The sample is the first
 *   `--lme / 6` of each question type by id, the same on every run.
 * - LoCoMo: one conversation is one workspace and one person, and evidence
 *   `D<k>:<n>` names session k. Adversarial questions (category 5) have no
 *   answer in the conversation and are skipped.
 *
 * The score is session-level retrieval (hit@1, MRR), not the answer accuracy
 * the vendors headline, so it is not comparable to their published numbers.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Pinned to one revision each and checked by hash: the ids in these files become
// paths, and the script runs beside the benchmark's production keys.
const LME = {
  url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json",
  sha256: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
};
const LOCOMO = {
  url: "https://raw.githubusercontent.com/snap-research/locomo/cbfbc1dba6bc53d00625212a0f22d55ffee7c1fc/data/locomo10.json",
  sha256: "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4",
};
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const LME_TYPES = 6;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2023/05/20 (Sat) 02:21" -> "2023-05-20". */
export function lmeDate(value) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(value ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** "1:56 pm on 8 May, 2023" -> "2023-05-08". */
export function locomoDate(value) {
  const m = /(\d{1,2}) (\w+),? (\d{4})/.exec(value ?? "");
  const month = m ? MONTHS.indexOf(m[2]) + 1 : 0;
  return month ? `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

/** The session numbers a LoCoMo evidence list names: ["D1:3", "D4:10"] -> [1, 4]. */
export function evidenceSessions(evidence) {
  return [...new Set((evidence ?? []).map((id) => Number(/D(\d+)/.exec(id)?.[1])).filter(Boolean))];
}

function sessionNote(title, date, turns) {
  const front = date ? `---\ndate: ${date}\n---\n\n` : "";
  return `${front}# ${title}\n\n${turns.map(([who, text]) => `**${who}:** ${text}`).join("\n\n")}\n`;
}

/** The first `count / 6` non-abstention questions of each type, by id. */
export function sampleLme(entries, count) {
  const byType = new Map();
  for (const e of [...entries].sort((a, b) => a.question_id.localeCompare(b.question_id))) {
    if (e.question_id.endsWith("_abs")) continue;
    if (!byType.has(e.question_type)) byType.set(e.question_type, []);
    byType.get(e.question_type).push(e);
  }
  const each = Math.ceil(count / LME_TYPES);
  return [...byType.keys()].sort().flatMap((type) => byType.get(type).slice(0, each)).slice(0, count);
}

/** A dataset id that becomes one path segment: letters, digits, `_` and `-` only. */
export function safeId(id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new Error(`dataset id ${JSON.stringify(id)} is not a safe path segment`);
  return id;
}

function lmeWorld(entries) {
  return entries.map((e, i) => {
    const workspace = `lme-${safeId(e.question_id).toLowerCase()}`;
    const files = {};
    e.haystack_session_ids.map(safeId).forEach((id, k) => {
      const turns = e.haystack_sessions[k].map((t) => [t.role, t.content]);
      files[`inbox/sessions/${id}.md`] = sessionNote(`Chat session ${id}`, lmeDate(e.haystack_dates[k]), turns);
    });
    const expect = e.answer_session_ids.map(safeId).map((id) => `@${workspace}/inbox/sessions/${id}.md`);
    return { workspace, person: `Lme${i + 1}`, files, questions: [{ text: e.question, expect, label: `LongMemEval ${e.question_type}` }] };
  });
}

function locomoWorld(conversations) {
  return conversations.map((c, i) => {
    const workspace = `locomo-${safeId(c.sample_id).toLowerCase()}`;
    const conv = c.conversation;
    const files = {};
    for (let k = 1; conv[`session_${k}`]; k++) {
      const turns = conv[`session_${k}`].map((t) => [t.speaker, t.text]);
      files[`inbox/sessions/session-${k}.md`] = sessionNote(`${conv.speaker_a} and ${conv.speaker_b}, session ${k}`, locomoDate(conv[`session_${k}_date_time`]), turns);
    }
    const questions = c.qa
      .filter((q) => q.category !== 5)
      .map((q) => ({ text: String(q.question), expect: evidenceSessions(q.evidence).filter((k) => files[`inbox/sessions/session-${k}.md`]).map((k) => `@${workspace}/inbox/sessions/session-${k}.md`), label: `LoCoMo category ${q.category}` }))
      .filter((q) => q.expect.length);
    return { workspace, person: `Locomo${i + 1}`, files, questions };
  });
}

/** Write the bench folder for `worlds` under `out`. */
export async function writeBenchFolder(out, worlds) {
  for (const w of worlds) {
    for (const [rel, text] of Object.entries(w.files)) {
      await mkdir(join(out, "workspaces", w.workspace, rel, ".."), { recursive: true });
      await writeFile(join(out, "workspaces", w.workspace, rel), text);
    }
  }
  const rows = worlds.map((w) => `| ${w.person} | ${w.workspace} (personal) | owner |`);
  await writeFile(join(out, "workspaces", "people.md"), `# People\n\n| Person | Workspace | Role |\n|---|---|---|\n${rows.join("\n")}\n`);
  await writeFile(join(out, "README.md"), "# Public memory benchmarks\n\nGenerated by `bench/publicSets.mjs`. Not committed.\n");
  let n = 0;
  const sections = worlds.flatMap((w) => w.questions.map((q) => `## ${++n}. ${q.text.replace(/\s+/g, " ").trim()}\n\n- as: ${w.person}\n- expect: ${q.expect.join(", ")}\n`));
  await mkdir(join(out, "tests"), { recursive: true });
  await writeFile(join(out, "tests", "search.md"), `---\njob: search\nruns: 1\n---\n\n# Public memory benchmarks, session-level retrieval\n\n${sections.join("\n")}`);
  // Production's search setup (`@context-lc ai/setups/search/everywhere.md`): search's defaults written out.
  await mkdir(join(out, "setups", "search"), { recursive: true });
  await writeFile(join(out, "setups", "search", "everywhere.md"), "---\njob: search\nsearch:\n  everywhere: true\n---\n");
  return n;
}

async function download({ url, sha256 }) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha256) throw new Error(`${url}: sha256 ${got}, expected ${sha256}`);
  return JSON.parse(bytes.toString("utf8"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, ...rest] = process.argv.slice(2);
  if (!out) throw new Error("usage: node bench/publicSets.mjs <out-dir> [--lme 30] [--locomo 10]");
  const flag = (name, fallback) => (rest.includes(name) ? Number(rest[rest.indexOf(name) + 1]) || fallback : fallback);
  const lmeCount = flag("--lme", 30);
  const locomoCount = flag("--locomo", 10);
  // One folder per benchmark, so each is scored on its own: mixed, LoCoMo's 1,500 questions drown LongMemEval's 30.
  for (const [name, worlds] of [
    ["lme", lmeWorld(sampleLme(await download(LME), lmeCount))],
    ["locomo", locomoWorld((await download(LOCOMO)).slice(0, locomoCount))],
  ]) {
    const n = await writeBenchFolder(join(out, name), worlds);
    console.log(`${join(out, name)}: ${worlds.length} workspaces, ${n} questions`);
  }
}
