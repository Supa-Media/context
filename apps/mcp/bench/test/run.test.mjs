// `pnpm ai run` with --fake, on an invented folder in a temp dir: the fluff switch and what
// the result note records. Fake runs spend nothing and need no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const RUN = join(dirname(fileURLToPath(import.meta.url)), "..", "run.mjs");
const execFileAsync = promisify(execFile);

const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";
const TEST = "---\nrun_as: Ana\nruns: 1\n---\n\n## 1. When is my dentist appointment?\n\n- kind: lookup\n- must: say Tuesday\n";
const FLUFF = [
  "---",
  "count: 5",
  "seed: 3",
  "from: meetings",
  "name: meeting-{date}.md",
  "dates: 2026-01-05 to 2026-10-01",
  "---",
  "",
  "## Distractors",
  "",
  "- older copy of ../health/dentist.md as dentist-old.md dated 2026-03-02",
  "",
].join("\n");

/** An invented folder with one workspace, a fluff folder, a template bank and one setup. */
async function benchFolder() {
  const dir = await mkdtemp(join(tmpdir(), "bench-run-"));
  const files = {
    "README.md": "# Bench\n",
    "workspaces/people.md": "| Person | Workspace | Role |\n|---|---|---|\n| Ana | ana (personal) | owner |\n",
    "workspaces/ana/health/dentist.md": "Dentist Tuesday 3 pm\n",
    "workspaces/ana/meetings/fluff.md": FLUFF,
    "workspaces/_bank/meetings/standup.md": "---\ntitle: Standup\n---\n\nStandup {n}, {word}.\n",
    "tests/texting-assistant.md": TEST,
    "setups/texting-assistant/production.md": SETUP,
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

/** Run the fake benchmark and return the result note's front matter, as lines. */
async function runFake(dir, extra = []) {
  const out = join(dir, "result.md");
  await execFileAsync(process.execPath, [RUN, "run", "texting-assistant", "--dir", dir, "--fake", "--out", out, ...extra], {
    timeout: 120000,
  });
  return (await readFile(out, "utf8")).split("\n---\n")[0].split("\n");
}

test("fluff is on by default and the result says how many notes it wrote", async () => {
  const dir = await benchFolder();
  try {
    const head = await runFake(dir);
    assert.ok(head.includes("fluff: on"), head.join("\n"));
    // Five filler notes and the one distractor copy.
    assert.ok(head.includes("fluff_notes: 6"), head.join("\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--no-fluff skips the expansion and the result says so", async () => {
  const dir = await benchFolder();
  try {
    const head = await runFake(dir, ["--no-fluff"]);
    assert.ok(head.includes("fluff: off"), head.join("\n"));
    assert.ok(head.includes("fluff_notes: 0"), head.join("\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--parallel answers the conversations in child processes and assembles the same result", async () => {
  const dir = await benchFolder();
  try {
    const front = await runFake(dir, ["--parallel", "2", "--runs", "2"]);
    const out = await readFile(join(dir, "result.md"), "utf8");
    assert.ok(front.some((line) => line === "runs_per_question: 2"), front.join("\n"));
    const ids = out.match(/^#### \S+$/gm) ?? [];
    assert.equal(ids.length, 2 * (out.match(/^### \d+\. /gm) ?? []).length, "every question has both runs");
    assert.ok(!out.includes("Error:"), out.slice(0, 600));
    // Every conversation's ledger file is beside the result (`modelLog.mjs`), and none is in the result note.
    const ledgers = (await readdir(join(dir, "result ledgers"))).sort();
    assert.equal(ledgers.length, ids.length, ledgers.join(", "));
    const ledger = JSON.parse((await readFile(join(dir, "result ledgers", ledgers[0]), "utf8")).split("```json\n")[1].split("\n```")[0]);
    assert.equal(ledger.schema, "bench-ledger");
    assert.ok(ledger.model.calls.length > 0 && ledger.conversation.length > 0 && ledger.turns.length > 0);
    assert.ok(!out.includes('"schema": "bench-ledger"') && !out.includes("bench-ledger"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shards cover every conversation exactly once, and the shard count has a ceiling", async () => {
  const { parallelFor, shardJobs } = await import("../run.mjs");
  const jobs = Array.from({ length: 10 }, (_, k) => ({ k }));
  const shards = [0, 1, 2].map((index) => shardJobs(jobs, index, 3));
  assert.deepEqual(shards.map((s) => s.length), [4, 3, 3]);
  assert.deepEqual(shards.flat().map((j) => j.k).sort((a, b) => a - b), jobs.map((j) => j.k));
  assert.equal(parallelFor({}, 708), 6, "up to six processes by default");
  assert.equal(parallelFor({ fake: true }, 708), 1, "a fake run stays in one process unless asked");
  assert.equal(parallelFor({ parallel: "4" }, 708), 4);
  assert.equal(parallelFor({ parallel: "12" }, 5), 5, "never more shards than conversations");
});

test("the texting assistant runs its core set unless a test is named, and a folder without one runs the job's own", async () => {
  const { testFor } = await import("../run.mjs");
  const both = { core: {}, "texting-assistant": {}, tasks: {} };
  assert.equal(testFor({ job: "texting-assistant" }, both), "core", "decided by the owner, 2026-10-14");
  assert.equal(testFor({ job: "texting-assistant", test: "texting-assistant" }, both), "texting-assistant", "the long set, by name");
  assert.equal(testFor({ job: "texting-assistant", test: "tasks" }, both), "tasks");
  assert.equal(testFor({ job: "texting-assistant" }, { "texting-assistant": {} }), "texting-assistant", "an older folder");
  assert.equal(testFor({ job: "search" }, both), "search", "another job keeps its own");
});

test("the played person answers YES when the gateway held a call for their OK, and is otherwise played", async () => {
  const { personAnswers } = await import("../run.mjs");
  assert.equal(personAnswers({ asked: 1, answer: "Shall I?\n\nBefore I do that, I need your OK: write x into @y. Reply YES to go ahead, or NO to drop it." }), "YES");
  assert.equal(personAnswers({ asked: 2, answer: "…" }), "YES", "one yes answers every held call the ask named");
  assert.equal(personAnswers({ asked: 0, answer: "Done." }), null, "a clean turn is for the played person or nobody");
  assert.equal(personAnswers({ answer: "an older gateway with no asked field" }), null);
  assert.equal(personAnswers({ asked: 1, answer: "Give it a 👍" }, { answersAsks: true }), null, "a case that plays its asks answers them from the brief");
});

test("a housekeeping test runs Tex's housekeeping once and records where each named note ended up", async () => {
  const dir = await benchFolder();
  try {
    await writeFile(
      join(dir, "workspaces/people.md"),
      "| Person | Workspace | Role |\n|---|---|---|\n| Ana | ana (personal) | owner |\n",
    );
    await mkdir(join(dir, "workspaces/ana/1-projects/kitchen"), { recursive: true });
    await writeFile(join(dir, "workspaces/ana/1-projects/kitchen/overview.md"), "---\nstatus: finished\n---\n\n# Kitchen\n\nDone.\n");
    await writeFile(
      join(dir, "tests/housekeeping.md"),
      "---\nmode: housekeeping\nrun_as: Ana\nruns: 1\n---\n\n## 1. Leaves notes it is unsure of\n\n- kind: task\n" +
        "- must file: ana/health/dentist.md under ana/health/dentist.md\n- must file: ana/1-projects/kitchen/overview.md under ana/1-projects/\n",
    );
    // Housekeeping's own setup, as `pnpm ai pull housekeeping` writes it; the test is the job's own.
    await mkdir(join(dir, "setups/housekeeping"), { recursive: true });
    await writeFile(join(dir, "setups/housekeeping/production.md"), "---\njob: housekeeping\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nTidy what you are sure of.\n");
    const out = join(dir, "result.md");
    await execFileAsync(process.execPath, [RUN, "run", "housekeeping", "--dir", dir, "--fake", "--no-fluff", "--out", out], { timeout: 120000 });
    const note = await readFile(out, "utf8");
    const filed = JSON.parse(note.split("\n").find((line) => line.startsWith("Filed: ")).slice("Filed: ".length));
    assert.equal(filed["ana/health/dentist.md"].at, "ana/health/dentist.md", note);
    assert.equal(filed["ana/1-projects/kitchen/overview.md"].at, "ana/1-projects/kitchen/overview.md");
    assert.equal(filed["ana/1-projects/kitchen/overview.md"].front.status, "finished", "the front matter rides along for `with` checks");
    const { parseResult } = await import("../resultNote.mjs");
    const [answer] = parseResult(note).answers;
    assert.deepEqual(answer.where, filed, "the Filed line reads back as the run recorded it");
    assert.ok(note.includes("# Tex kept house,"), "the answer carries the log the run wrote");
    assert.ok(!note.includes("Error:"), note.slice(0, 800));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A world whose turns are scripted: each is `{answer, progress?, tools?, browser?}`. */
function scriptedWorld(turns) {
  const events = [];
  let n = 0;
  return {
    browser: () => [...events],
    async text() {
      const turn = turns[Math.min(n, turns.length - 1)];
      n += 1;
      events.push(...(turn.browser ?? []));
      return { ok: true, ms: 1, model: null, asked: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, progress: [], tools: [], ...turn };
    },
  };
}

const STREAMLY = {
  text: "When does my Streamly plan renew?",
  body: "",
  personStarts: null,
  ifAsked: [
    { when: "whether she signs in with Gmail or another email, or sent a link to save her login", say: "I'd rather just sign in myself this time" },
    { when: "to sign in, open a link, or take over the browser", say: "Done, I'm signed in" },
  ],
};

test("a handoff or a link to save a login is answered from the brief, not ended by the played person", async () => {
  const { converse } = await import("../run.mjs");
  // The fake person (`playPerson`) answers nothing, as a model reading "text me
  // when you're done" as nothing asked did: only the brief's lines carry on.
  const world = scriptedWorld([
    { answer: "Here's a link to save your Streamly login. Text me when you're done.", tools: [{ tool: "vault_add_link", ok: true }] },
    { answer: "I've opened Streamly. Sign in at the link and text me when you're done.", browser: ["open streamly.example/login", "handoff streamly.example"] },
    { answer: "It renews on 3 December.", browser: ["open streamly.example/account"] },
  ]);
  const result = await converse(world, STREAMLY, { fake: true });
  assert.deepEqual(
    result.conversation.filter((turn) => turn.from === "person").map((turn) => turn.text),
    [STREAMLY.text, "I'd rather just sign in myself this time", "Done, I'm signed in"],
  );
  assert.equal(result.conversation.at(-1).text, "It renews on 3 December.");
});

test("an earlier turn's handoff is not answered again, and a failed vault_add_link asks nothing", async () => {
  const { handOffAnswer } = await import("../run.mjs");
  assert.equal(handOffAnswer({ tools: [] }, STREAMLY, []), null);
  assert.equal(handOffAnswer({ tools: [{ tool: "vault_add_link", ok: false }] }, STREAMLY, []), null);
  assert.equal(handOffAnswer({ tools: [{ tool: "vault_add_link (held for OK)", ok: true }] }, STREAMLY, []), "I'd rather just sign in myself this time");
  assert.equal(handOffAnswer({ tools: [] }, { ifAsked: [] }, ["handoff streamly.example"]), null, "a brief with no line for it is the played person's");
});

test("each progress line the turn texted counts as one of the assistant's texts, before its answer", async () => {
  const { converse } = await import("../run.mjs");
  const world = scriptedWorld([{ answer: "Done.", progress: ["Opening Streamly now."] }]);
  const result = await converse(world, { ...STREAMLY, ifAsked: [] }, { fake: true });
  assert.deepEqual(
    result.conversation.map((turn) => turn.text),
    [STREAMLY.text, "Opening Streamly now.", "Done."],
  );
  assert.equal(result.texts, 2);
});

test("a brief with more if-asked lines than four texts allow gets room for every one of them", async () => {
  const { converse, personTextLimit } = await import("../run.mjs");
  const domain = {
    ...STREAMLY,
    ifAsked: [
      ...STREAMLY.ifAsked,
      { when: "to confirm the domain and price", say: "Yes, buy mayaruns.com for $11.08" },
      { when: "whether Tex may add the DNS records itself", say: "Yes, go ahead" },
    ],
  };
  assert.equal(personTextLimit({ ifAsked: [] }), 4, "a short brief keeps the old limit");
  assert.equal(personTextLimit(domain), 6);
  // Every turn holds a write for her OK, so she answers each one: only the limit stops her.
  const world = scriptedWorld([{ answer: "Can I go ahead?", asked: 1 }]);
  const result = await converse(world, domain, { fake: true });
  assert.equal(result.conversation.filter((turn) => turn.from === "person").length, 6);
});

test("a housekeeping run puts its setup where housekeeping reads it, beside a plain texting one", async () => {
  const { setupInWorld } = await import("../run.mjs");
  const setup = { raw: "---\njob: housekeeping\n---\n\nTidy.\n" };
  const [texting, models] = setupInWorld("housekeeping", setup, { pinnedNotes: [{ path: "ai/production/dream.md", raw: "d" }] });
  assert.match(texting, /job: texting-assistant/);
  assert.deepEqual(models.pinnedNotes.map((note) => note.path), ["ai/production/dream.md", "ai/production/housekeeping.md"]);
  assert.equal(models.pinnedNotes[1].raw, setup.raw);
  const [own, same] = setupInWorld("texting-assistant", setup, {});
  assert.equal(own, setup.raw);
  assert.deepEqual(same, {});
});

test("with background on, every text sends the case's running jobs, and the jobs it started are kept", async () => {
  const { benchRunning, converse } = await import("../run.mjs");
  const sent = [];
  const world = {
    browser: () => [],
    async text(_message, _pictures, options) {
      sent.push(options?.running ?? null);
      return { ok: true, ms: 1, model: null, asked: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, progress: [], tools: [], answer: "On it.", jobs: [{ title: "Find flights", mail: "p/overview.md", name: "flights", on: null }] };
    },
  };
  const result = await converse(world, { ...STREAMLY, ifAsked: [], running: 2 }, { fake: true }, null, true);
  assert.equal(sent[0].length, 2, "two already running");
  assert.equal(result.jobs.length, 1);
  const off = [];
  await converse({ ...world, async text(m, p, options) { off.push(options?.running ?? null); return world.text(m, p, options); } }, { ...STREAMLY, ifAsked: [] }, { fake: true });
  assert.equal(off[0], null, "a test without background sends none, so no jobs are offered");
  assert.equal(benchRunning(0).length, 0);
  assert.ok(benchRunning(9).length <= 6);
  for (const job of benchRunning(3)) assert.match(job.id, /^[A-Za-z0-9_-]{8,64}$/, "an id the gateway reads");
  // A job a case's earlier 🔎 started is running with its title, started when that tapback was (`setsFd.mjs` runningJobOf).
  const [named] = benchRunning(0, [{ title: "Compare the tortilla places", minutesBefore: 5 }]);
  assert.equal(named.title, "Compare the tortilla places");
  assert.equal(named.state, "running");
  assert.ok(Math.abs(Date.now() - 5 * 60_000 - named.startedAt) < 1000, "started five minutes before");
  assert.equal(benchRunning(2, [{ title: "Compare the tortilla places" }]).length, 3, "named jobs run beside the counted ones");
});

test("a test's computer line is read strictly", async () => {
  const { readComputer } = await import("../run.mjs");
  assert.deepEqual(readComputer("Studio Mac (claude, codex) 3 slots"), { name: "Studio Mac", tools: ["claude", "codex"], slots: 3 });
  assert.deepEqual(readComputer("Laptop (codex)"), { name: "Laptop", tools: ["codex"], slots: 1 });
  assert.equal(readComputer(undefined), null);
  assert.throws(() => readComputer("Studio Mac with claude"), /is not/);
  assert.throws(() => readComputer("Studio Mac (vim) 2 slots"), /is not/);
});

test("a turn that ends in a tapback shows the judge that tapback, never silence, and it is not a text", async () => {
  const { converse, tapbackLine } = await import("../run.mjs");
  assert.equal(tapbackLine(undefined), null);
  assert.equal(tapbackLine(null), null);
  assert.equal(tapbackLine(""), "(Tex reacted to their text)");
  assert.equal(tapbackLine("🗓️"), "(Tex reacted 🗓️ to their text)");
  const world = scriptedWorld([{ answer: "", react: "" }]);
  const result = await converse(world, { ...STREAMLY, ifAsked: [] }, { fake: true });
  assert.deepEqual(result.conversation.map((turn) => turn.text), [STREAMLY.text, "", "(Tex reacted to their text)"]);
  assert.equal(result.texts, 1, "the tapback is a line the person saw, not a text Tex sent");
});

test("a job a texted turn started runs part after part, and its report is the person's later text", async () => {
  const { converse } = await import("../run.mjs");
  const calls = [];
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  const turn = (fields) => ({ ok: true, ms: 1, model: null, asked: 0, usage, usageByModel: { "anthropic/claude-haiku-5-5": usage }, progress: [], tools: [], jobs: [], answer: "", ...fields });
  const modelCalls = [];
  const world = {
    browser: () => [],
    modelCalls: () => modelCalls,
    async text(message, _pictures, options = {}) {
      calls.push({ message, job: options.job ?? null, posted: options.posted === true, event: options.event ?? null });
      if (options.job) modelCalls.push({ messages: [{ role: "user", text: "Is the job finished?" }] }); // the job advisor's done check, each part
      if (options.job) return turn(options.job.attempt === 1 ? { answer: "Found two flights so far.", verdict: "keep_going", advice: "check the second airline" } : { answer: "Two flights: 7:10 am $210, 1:40 pm $180. Saved to Trip.", verdict: "done" });
      if (options.event?.event === "job_report") return turn({ answer: `Flights: ${options.event.jobReport.texts[0]}` });
      return turn({ answer: "On it.", jobs: [{ title: "Find flights", brief: "Compare the two airlines", mail: null, name: null, on: null }] });
    },
  };
  const result = await converse(world, { ...STREAMLY, ifAsked: [] }, { fake: true }, null, true);
  const parts = calls.filter((call) => call.job !== null);
  assert.deepEqual(parts.map((call) => call.job.attempt), [1, 2], "the check said not finished, so a second part ran on its advice");
  assert.equal(parts[1].job.advice, "check the second airline");
  assert.ok(parts.every((call) => call.posted && call.message === STREAMLY.text), "the job runs on the ask its turn started from, which the chat already holds");
  const report = calls.find((call) => call.event?.event === "job_report");
  assert.deepEqual(report.event.jobReport.texts, ["Two flights: 7:10 am $210, 1:40 pm $180. Saved to Trip."], "the last part's words are the report");
  assert.equal(report.event.jobReport.state, "done");
  assert.deepEqual(result.conversation.at(-1), { from: "assistant", text: "Flights: Two flights: 7:10 am $210, 1:40 pm $180. Saved to Trip.", later: "texted when the background job finished" });
  assert.equal(result.texts, 1, "the reply is one text; the report came later");
  assert.equal(result.usage.input, 40, "the job's parts and its report are the test's spend");
  const [delivered] = result.delivered;
  assert.deepEqual({ ...delivered, usd: undefined }, { title: "Find flights", state: "done", parts: 2, advisorCalls: 2, usd: undefined }, "each part's done check is one advisor call");
  assert.ok(delivered.usd > 0, "and what the job cost is kept beside it");
  const quiet = [];
  await converse({ ...world, async text(m, p, o) { quiet.push(o ?? {}); return world.text(m, p, o); } }, { ...STREAMLY, ifAsked: [] }, { fake: true });
  assert.ok(quiet.every((o) => !o.job && !o.event), "without background no job is offered, so none runs");
});

test("a job past the bench's bound is recorded as not run, and a job its parts ran out on is marked capped", async () => {
  const { converse } = await import("../run.mjs");
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const turn = (fields) => ({ ok: true, ms: 1, model: null, asked: 0, usage, progress: [], tools: [], jobs: [], answer: "", ...fields });
  const world = {
    browser: () => [],
    async text(_m, _p, options = {}) {
      if (options.job) return turn({ answer: "Still going.", verdict: "keep_going" });
      if (options.event?.event === "job_report") return turn({ answer: "Here's where it got to." });
      return turn({ answer: "On it.", jobs: ["A", "B", "C"].map((title) => ({ title, brief: title })) });
    },
  };
  const result = await converse(world, { ...STREAMLY, ifAsked: [] }, { fake: true }, null, true);
  assert.deepEqual(result.delivered, [
    { title: "A", state: "stuck", parts: 4, advisorCalls: 0, usd: 0, capped: true },
    { title: "B", state: "stuck", parts: 4, advisorCalls: 0, usd: 0, capped: true },
    { title: "C", state: "not run", parts: 0, advisorCalls: 0, usd: 0 },
  ]);
  assert.deepEqual(result.conversation.map((line) => line.later ? "later" : line.from), ["person", "assistant", "later", "later"], "each report follows the reply it came from");
});

test("a result's Delivered line carries each job's advisor calls and spend to the Lab run's row", async () => {
  const { handoffTotals } = await import("../jobDelivery.mjs");
  const { parseResult } = await import("../resultNote.mjs");
  const delivered = [{ title: "A", state: "done", parts: 3, advisorCalls: 3, usd: 0.0212 }, { title: "B", state: "not run", parts: 0, advisorCalls: 0, usd: 0 }];
  assert.deepEqual(handoffTotals(delivered), { jobs: 1, parts: 3, advisorCalls: 3, usd: 0.0212 }, "a job that never ran adds nothing");
  const md = ["## Answers", "", "### 1. hi", "", "#### s/q1/r1", "", "**Person:** hi", "", "**Assistant:** On it.", "", "Tools: none", "", `Delivered: ${JSON.stringify(delivered)}`, "", "Time 1.0 s, $0.0100, 1 text", ""].join("\n");
  const [answer] = parseResult(md).answers;
  assert.deepEqual(answer?.delivered, delivered);
});

test("a result's Rounds line carries each texted turn's rounds of its bound to the Lab run's row", async () => {
  const { parseResult } = await import("../resultNote.mjs");
  const rounds = [{ used: 3, of: 12 }, { used: 10, of: 12, out: true }];
  const md = ["## Answers", "", "### 1. text", "", "#### s/q1/r1", "", "**Person:** hi", "", "**Assistant:** On it.", "", "Tools: none", "", `Rounds: ${JSON.stringify(rounds)}`, "", "Time 1.0 s, $0.0100, 1 text", ""].join("\n");
  const [answer] = parseResult(md).answers;
  assert.deepEqual(answer?.rounds, rounds);
  const [none] = parseResult(md.replace(/Rounds: .*\n\n/, "")).answers;
  assert.deepEqual(none?.rounds, [], "a result from before the line reads no rounds");
});

test("a result's Route line carries each texted turn's route to the Lab run's row (the router's pick, its door, a fallback)", async () => {
  const { parseResult } = await import("../resultNote.mjs");
  const routes = [{ pick: "read", sure: 0.9, door: "read" }, { pick: "act", door: "fd", fellBack: "outside the read door's tools: send_email" }];
  const md = ["## Answers", "", "### 1. text", "", "#### s/q1/r1", "", "**Person:** hi", "", "**Assistant:** On it.", "", "Tools: none", "", `Route: ${JSON.stringify(routes)}`, "", "Time 1.0 s, $0.0100, 1 text", ""].join("\n");
  const [answer] = parseResult(md).answers;
  assert.deepEqual(answer?.routes, routes);
  const [none] = parseResult(md.replace(/Route: .*\n\n/, "")).answers;
  assert.deepEqual(none?.routes, [], "a result from before the line reads no routes");
});

// A turn that texted nothing is a silent record line: quiet or stopped. A failed turn's apology is not silent.
test("silentTurn: quiet and stopped turns are silent, words and a failed turn are not", async () => {
  const { silentTurn } = await import("../run.mjs");
  assert.equal(silentTurn({ answer: "", quiet: true }), true);
  assert.equal(silentTurn({ answer: "", cancelled: true }), true);
  assert.equal(silentTurn({ answer: "hi" }), false);
  assert.equal(silentTurn({ answer: "" }), false);
});
