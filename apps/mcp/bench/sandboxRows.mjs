/**
 * A LAB SANDBOX BENCH UNIT'S ROW, JUDGED AND COUNTED BY THE GITHUB RUN'S OWN CODE (plan
 * `products/tex/research/sandbox-bench-scoring-2026-11-19.md`; must-have: "invalid-row and model-fallback accounting
 * identical to the GitHub run, implemented through the same code paths").
 *
 * The gateway runs the unit's turn (`packages/lab/gateway/labSandbox/benchTurn.js`); this turns it into the bench's
 * own files and then runs exactly what the GitHub run runs on its own answers, in the same order:
 *
 *   1. the unit's test as the GitHub run writes it (`setsFd.mjs` `fdTest`, the front matter `frontFor` gives), one
 *      question, as `prepareConvo` writes a person-day's test;
 *   2. the answer as a result note and its key (`report.mjs` `resultMarkdown`, `keyMarkdown`), its tools carrying each
 *      fallback the turn's ledger kept as the bench writes one (`rowAccounting.mjs` `fallbackToolsOf`);
 *   3. the judge (`judge.mjs` `judgeFile`, Haiku through `labJudge`, its prompt and votes unchanged);
 *   4. the judged cases (`coreArea.mjs` `coreCases`: fallbacks by `answersFallbacks`) and the unit's row
 *      (`setsFdRows.mjs` `collectConvo`: a turn that could not run is `couldNotRunRow`'s).
 *
 * The run's results are then `scripts/tex-lab-run.mjs` `resultsOf` over the rows, the GitHub run's own verdict
 * (`runVerdict`: fallbacks and broken runs mark it invalid). Nothing here is a copy of any of them.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { coreCases } from "./coreArea.mjs";
import { DEFAULT_JUDGE, DEFAULT_VOTES, judgeFile, labJudge } from "./judge.mjs";
import { parsePeople } from "./load.mjs";
import { frontMatter } from "./resultNote.mjs";
import { keyMarkdown, keyPathFor, priceUsd, resultMarkdown } from "./report.mjs";
import { fallbackToolsOf } from "./rowAccounting.mjs";
import { fdTest, frontFor, groupFor, senderOf } from "./setsFd.mjs";
import { collectConvo } from "./setsFdRows.mjs";

/** The bench folder the GitHub run copies for each conversation; read here, never written. */
export const BENCH_DIR = new URL("./ai/", import.meta.url).pathname;
const SETUP = "production";

/** A unit's row key, as a runner row carries it. */
export const rowOf = (unit) => ({ chat: unit.chat, msg: unit.msg, at: unit.at, node: "fd", rep: unit.rep ?? 0 });

/**
 * The sandbox turn as one bench run (`run.mjs`'s shape, read by `resultMarkdown`): the person's text, Tex's texts, its
 * tools with a `fallback: ...` entry for each fallback step, what it would have changed, its usage by model (only
 * models the bench has a price for, so an unpriced helper never makes the whole price unknown).
 */
export function benchRunOf({ person, text, turn }) {
  const said = Array.isArray(turn.said) ? turn.said : [];
  const usageByModel = {};
  for (const u of Array.isArray(turn.usage) ? turn.usage : []) {
    if (typeof u?.model !== "string" || priceUsd(u.model, {}) === null) continue;
    const kept = (usageByModel[u.model] ??= { input: 0, output: 0 });
    kept.input += Number(u.input) || 0;
    kept.output += Number(u.output) || 0;
  }
  return {
    setup: SETUP,
    question: 1,
    run: 1,
    questionText: String(text).replace(/\s+/g, " ").slice(0, 120),
    as: person,
    kind: "task",
    conversation: [{ from: "person", text }, ...said.map((words) => ({ from: "assistant", text: words }))],
    tools: [...(Array.isArray(turn.tools) ? turn.tools : []), ...fallbackToolsOf(turn.fallbacks)],
    changes: (Array.isArray(turn.changes) ? turn.changes : []).map((c) => ({ kind: c.kind, workspace: "sandbox", path: c.title, detail: "kept in the test chat, never carried out" })),
    usageByModel,
    ms: Number(turn.ms) || 0,
    texts: said.length,
  };
}

/**
 * One unit's row. `unit` is the job's (`labRunSets.mjs` `benchUnits`), `conv` the copy it ran, `turn` the gateway's.
 * `send` is the judge's transport (`models.mjs` `claudeTransport`, or `judge.mjs` `fakeJudge` in a test).
 */
export async function sandboxRow({ unit, conv, turn, scratch, send, model = labJudge(DEFAULT_JUDGE), votes = DEFAULT_VOTES, benchDir = BENCH_DIR, commit = "sandbox", maxUsd }) {
  const row = rowOf(unit);
  const name = `sets-u${unit.i}`;
  const one = (test) => collectConvo({ rows: [], runDir: null, tests: [{ name, group: [{ row }], ...test }] })[0];
  if (!turn || turn.ran !== true) return one({ error: new Error(turn?.error ?? "the sandbox gave no turn") });

  const m = conv.msgs[unit.at];
  const people = parsePeople(await readFile(join(benchDir, "workspaces", "people.md"), "utf8"));
  const group = conv.kind === "group" ? groupFor(people, conv) : null;
  if (conv.kind === "group" && group === null) return one({ error: new Error("no shared workspace in the bench's people has this group's people") });
  const person = senderOf(conv, unit.at, people, group);
  // The day Tex's turn ran on: the judge reads the answer against it.
  const today = new Date(Number(turn.at) || Date.now()).toISOString().slice(0, 10);
  const front = await frontFor(benchDir, person, { today, group, setting: String(conv.setting ?? "") });
  if (front === null) return one({ error: new Error(`${person} has no bench world: a set chat's people are the bench's (apps/mcp/bench/ai/workspaces/people.md)`) });

  const dir = join(scratch, `u${unit.i}`);
  const ai = join(dir, "ai");
  await mkdir(join(ai, "tests"), { recursive: true });
  const testRaw = fdTest([{ convo: conv, at: unit.at, label: m.labels.fd, row }], front, null);
  await writeFile(join(ai, "tests", `${name}.md`), testRaw);
  const path = join(dir, `${name}.md`);
  const result = {
    job: "texting-assistant",
    test: name,
    testVersion: createHash("sha256").update(testRaw).digest("hex").slice(0, 12),
    date: today,
    today,
    commit,
    setups: [{ name: SETUP, version: "sandbox", model: "sandbox" }],
    runs: [benchRunOf({ person, text: m.text, turn })],
    keyFile: basename(keyPathFor(path)),
    resultFile: basename(path),
  };
  await writeFile(path, resultMarkdown(result));
  await writeFile(keyPathFor(path), keyMarkdown(result));
  try {
    await judgeFile({ path, dir: ai, send, model, votes, ...(maxUsd !== undefined ? { maxUsd } : {}) });
    const resultRaw = await readFile(path, "utf8");
    const keyRaw = await readFile(join(dirname(path), frontMatter(resultRaw).key), "utf8");
    const got = coreCases({ test: name, testRaw, resultRaw, keyRaw });
    return one({ got });
  } catch (error) {
    // A judge that failed (out of credit included) marks this unit as the GitHub run marks a test that threw.
    return one({ error });
  }
}
