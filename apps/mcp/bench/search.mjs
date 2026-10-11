/**
 * THE SEARCH BENCHMARK: DOES `search_notes` BRING BACK THE NOTE?
 *
 * Asked for by the owner (2026-10-10): "a testing pipeline for search, using
 * the same pipeline we were using to evaluate prompts", then "tweak the
 * embedding or search settings until it's returning the best items in a good
 * rank", then put the winner under the texting assistant.
 *
 * The same world as the texting benchmark (`world.mjs`, warmed with both
 * indexes by `warm.mjs`), the same invented people, and a test file of queries
 * (`tests/search.md`) where each question names the notes that should come
 * back. A setup here is a search setup (`setups/search/*.md`,
 * `parseSearchSetup`): the settings `search/settings.js` reads, which the
 * world puts in the Worker's `SEARCH_SETTINGS` var. Each query is one
 * `search_notes` call as the person, through the MCP endpoint; the paths in
 * the answer are read back and compared with what was expected. No judge, no
 * model but the embedder: a round costs the embeddings and seconds.
 *
 *   pnpm ai search [--dir <folder>] [--setups a,b] [--questions 1,2] [--out <note>] [--fake]
 *
 * Scored per setup: how often an expected note was in the answer at all
 * (found), in the first three (top 3), the mean reciprocal rank of the first
 * expected note (MRR), how often every expected note was there (complete),
 * the median time, and how many hits were shown. The bars are the test's
 * `good_enough.found` and `good_enough.top3`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { parseSearchSetup } from "../src/agent/production.js";
import { realNow } from "./clock.mjs";
import { benchFolder } from "./folder.mjs";
import { expandWorkspaces, readBenchFolder } from "./load.mjs";
import { cachedEmbeddings, fakeAi, fakeGateway, workersAi } from "./models.mjs";
import { prepareRun } from "./warm.mjs";
import { createWorld } from "./world.mjs";

/** A search setup's world needs a texting setup note too; this one is never a model's words. */
const PLAIN_TEXTING_SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

const list = (value) => (value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : null);
const today = () => new Date().toISOString().slice(0, 10);

function commit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function readSearchSetups(dir, only) {
  const folder = join(dir, "setups", "search");
  const names = (await readdir(folder)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();
  const chosen = only ? names.filter((name) => only.includes(name)) : names;
  if (chosen.length === 0) throw new Error("no setups to run in setups/search/");
  const setups = [];
  for (const name of chosen) {
    const raw = await readFile(join(folder, `${name}.md`), "utf8");
    const parsed = await parseSearchSetup(raw);
    if (!parsed) throw new Error(`setups/search/${name}.md is not a valid search setup file`);
    setups.push({ name, raw, version: parsed.version, search: parsed.search });
  }
  return setups;
}

/**
 * The note paths in a `search_notes` answer, in the order shown, each as
 * `@workspace/path`: a hit from another workspace already carries its name;
 * one from the workspace searched gets `home` in front.
 */
export function hitsOf(text, home) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!/^\S.*\.md$/.test(line)) continue;
    out.push(line.startsWith("@") ? line : `${home}/${line}`);
  }
  return out;
}

/** Where the first expected note placed (1-based), or null when none was shown. */
export function rankOf(hits, expected) {
  const wanted = new Set(expected);
  const index = hits.findIndex((hit) => wanted.has(hit));
  return index === -1 ? null : index + 1;
}

const pct = (n, of) => (of === 0 ? "n/a" : `${((100 * n) / of).toFixed(1)}%`);
const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** One row per setup, from its records. */
export function scoreSearch(records, setups, bars) {
  return setups.map((setup) => {
    const all = records.filter((record) => record.setup === setup.name);
    // A privacy question (forbid lines, nothing expected) is a gate, not a score.
    const leaks = all.filter((record) => (record.forbid ?? []).some((path) => record.hits.includes(path)));
    const mine = all.filter((record) => record.expected.length > 0);
    const found = mine.filter((record) => record.rank !== null).length;
    const top3 = mine.filter((record) => record.rank !== null && record.rank <= 3).length;
    const complete = mine.filter((record) => record.expected.every((path) => record.hits.includes(path))).length;
    const mrr = mine.length === 0 ? 0 : mine.reduce((total, record) => total + (record.rank === null ? 0 : 1 / record.rank), 0) / mine.length;
    const foundPct = mine.length === 0 ? 0 : (100 * found) / mine.length;
    const top3Pct = mine.length === 0 ? 0 : (100 * top3) / mine.length;
    return {
      setup: setup.name,
      queries: mine.length,
      found,
      top3,
      complete,
      mrr,
      medianMs: median(mine.map((record) => record.ms)),
      hitsShown: mine.length === 0 ? 0 : mine.reduce((total, record) => total + record.hits.length, 0) / mine.length,
      leaks: leaks.map((record) => `q${record.question}`),
      goodEnough: leaks.length === 0 && (bars.found === null || foundPct >= bars.found) && (bars.top3 === null || top3Pct >= bars.top3),
    };
  });
}

/** The bars from `good_enough`: "90%" is 90. */
export function searchBars(good = {}) {
  const read = (text) => {
    const m = String(text ?? "").match(/(\d+(?:\.\d+)?)\s*%/);
    return m ? Number(m[1]) : null;
  };
  return { found: read(good.found), top3: read(good.top3) };
}

/** The result note. */
export function searchResultMarkdown({ testVersion, date, codeCommit, setups, questions, records, bars, world, fluffNotes }) {
  const rows = scoreSearch(records, setups, bars);
  const best = [...rows].sort((a, b) => b.found - a.found || b.mrr - a.mrr)[0] ?? null;
  const front = [
    "---",
    "role: benchmark-result",
    "job: search",
    `date: ${date}`,
    `test_version: ${testVersion}`,
    `code_commit: ${codeCommit}`,
    `world: ${world}`,
    `fluff_notes: ${fluffNotes}`,
    `setups: [${setups.map((setup) => setup.name).join(", ")}]`,
    "status: scored",
    "---",
  ];
  const out = [
    ...front,
    "",
    `# Search benchmark, ${date}`,
    "",
    "## Summary",
    "",
    `This run asked ${questions.length} quer${questions.length === 1 ? "y" : "ies"} against ${setups.length} search setup${setups.length === 1 ? "" : "s"}, each one \`search_notes\` call as the person named, in a warm world with both indexes filled.`,
    "",
    "| Setup | Settings | Found | In top 3 | MRR | Complete | Privacy | Median time | Hits shown | Good enough |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => {
      const setup = setups.find((entry) => entry.name === row.setup);
      const settings = Object.entries(setup.search)
        .map(([key, value]) => `${key} ${value}`)
        .join(", ");
      return `| ${row.setup} | ${settings || "defaults"} | ${pct(row.found, row.queries)} | ${pct(row.top3, row.queries)} | ${row.mrr.toFixed(3)} | ${pct(row.complete, row.queries)} | ${row.leaks.length === 0 ? "passed" : `failed (${row.leaks.join(", ")})`} | ${(row.medianMs / 1000).toFixed(2)} s | ${row.hitsShown.toFixed(1)} | ${row.goodEnough ? "yes" : "no"} |`;
    }),
    "",
    `Bars: found ${bars.found === null ? "none" : `${bars.found}%`}, in top 3 ${bars.top3 === null ? "none" : `${bars.top3}%`}.${best ? ` Best: ${best.setup}.` : ""}`,
    "",
    "## Misses",
    "",
  ];
  for (const setup of setups) {
    const missed = records.filter((record) => record.setup === setup.name && record.expected.length > 0 && record.rank === null);
    out.push(`### ${setup.name}: ${missed.length} missed`, "");
    for (const record of missed) {
      out.push(`- q${record.question} "${record.text}" (${record.as}${record.in ? `, in ${record.in}` : ""}): wanted ${record.expected.join(", ")}; got ${record.hits.slice(0, 3).join(", ") || "nothing"}${record.error ? ` (error: ${record.error})` : ""}`);
    }
    out.push("");
  }
  out.push("## Answers", "");
  for (const question of questions) {
    const mine = records.filter((record) => record.question === question.n);
    const wants = [question.expect.length ? `Expected: ${question.expect.join(", ")}.` : "", question.forbid.length ? `Must not show: ${question.forbid.join(", ")}.` : ""].filter(Boolean).join(" ");
    out.push(`### ${question.n}. ${question.text}`, "", `Asked by ${mine[0]?.as ?? "?"}${question.in ? `, in ${question.in}` : ""}. ${wants}`, "");
    for (const record of mine) {
      const leaked = (record.forbid ?? []).some((path) => record.hits.includes(path));
      const verdict = question.expect.length === 0 ? (leaked ? "LEAKED" : "nothing leaked") : record.rank === null ? "not found" : `rank ${record.rank}`;
      out.push(`- ${record.setup}: ${verdict}${leaked && question.expect.length ? ", LEAKED" : ""}, ${(record.ms / 1000).toFixed(2)} s, ${record.hits.length} hits: ${record.hits.slice(0, 6).join(", ")}${record.hits.length > 6 ? ", …" : ""}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export async function searchCommand(options) {
  const dir = benchFolder(options);
  if (!dir) throw new Error("usage: pnpm ai search [--dir <benchmarks folder>] [--setups a,b] [--questions 1,2] [--out <note>] [--fake]");
  const loaded = await readBenchFolder(dir);
  const fluffOn = options["no-fluff"] !== true;
  const bench = fluffOn ? expandWorkspaces(loaded) : loaded;
  const fluffNotes = fluffOn ? Object.values(bench.workspaces).reduce((total, ws) => total + ws.generated.length, 0) : 0;
  const test = bench.tests.search;
  if (!test) throw new Error("no tests/search.md");
  const setups = await readSearchSetups(dir, list(options.setups));
  const only = list(options.questions)?.map(Number);
  const questions = test.questions.filter((question) => !only || only.includes(question.n));
  for (const question of questions) {
    if (question.expect.length === 0 && question.forbid.length === 0) throw new Error(`question ${question.n} names no expected or forbidden note (- expect: @workspace/path)`);
  }
  const bars = searchBars(test.front.good_enough);
  const fake = options.fake === true;
  const ai = fake ? cachedEmbeddings(fakeAi()) : cachedEmbeddings(workersAi(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_AI_TOKEN, process.env.AI_GATEWAY_ID ?? null));
  const todayPinned = test.front.today ?? null;
  const prepared = await prepareRun(bench, { today: todayPinned, ai });
  const passages = [...prepared.embedded.values()].reduce((total, n) => total + n, 0);
  process.stderr.write(`warmed ${prepared.buckets.size} workspaces, ${passages} passages in their meaning indexes\n`);
  const personal = new Map(bench.people.filter((row) => row.personal).map((row) => [row.person, `@${row.workspace}`]));

  const records = [];
  try {
    for (const setup of setups) {
      const models = { gatewayFetch: fakeGateway(), ai, searchSettings: setup.search };
      for (const question of questions) {
        const as = question.as ?? test.front.run_as;
        const home = question.in ?? personal.get(as);
        if (!home) throw new Error(`question ${question.n}: ${as} has no personal workspace in people.md`);
        const world = await createWorld(bench, as, PLAIN_TEXTING_SETUP, models, todayPinned, prepared);
        let rank = null;
        try {
          const started = realNow();
          const answer = await world.search(question.text, question.in);
          const hits = answer.ok ? hitsOf(answer.text, home) : [];
          rank = question.expect.length ? rankOf(hits, question.expect) : null;
          records.push({
            setup: setup.name,
            question: question.n,
            text: question.text,
            as,
            in: question.in,
            expected: question.expect,
            forbid: question.forbid,
            hits,
            rank,
            ms: realNow() - started,
            error: answer.ok ? null : answer.text.slice(0, 200),
          });
        } finally {
          world.close();
        }
        process.stderr.write(`${setup.name} q${question.n}: ${question.expect.length === 0 ? "privacy" : rank === null ? "miss" : `rank ${rank}`}\n`);
      }
    }
  } finally {
    prepared.close();
  }

  const date = today();
  const out = options.out ?? join(dir, "results", `${date} search.md`);
  await mkdir(join(out, ".."), { recursive: true });
  await writeFile(
    out,
    searchResultMarkdown({
      testVersion: createHash("sha256").update(test.raw).digest("hex").slice(0, 12),
      date,
      codeCommit: commit(),
      setups,
      questions,
      records,
      bars,
      world: "warm",
      fluffNotes,
    }),
  );
  const rows = scoreSearch(records, setups, bars);
  for (const row of rows) process.stderr.write(`${row.setup}: found ${pct(row.found, row.queries)}, top 3 ${pct(row.top3, row.queries)}, MRR ${row.mrr.toFixed(3)}\n`);
  process.stderr.write(`wrote ${basename(out)}\n`);
}
