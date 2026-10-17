// `pnpm ai run` with --fake, on an invented folder in a temp dir: the fluff switch and what
// the result note records. Fake runs spend nothing and need no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
