/**
 * THE TEX ARCHITECTURE LAB'S BENCH HALF (`bench/lab.mjs`; Dev2, 2026-11-13: a Lab version runs on the examiner path).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `readLabConfig` dropping the `..` refusal on a module path (applied, run, failed, reverted, 2026-11-13) ->
 *     "a module path that leaves ai/production is refused" fails;
 *  2. `applyLab` dropping its inside-the-setup-folder check (applied, run, failed, reverted, 2026-11-13) ->
 *     "a setup file cannot be written outside the setup folder" fails;
 *  3. `applyLab` skipping its readSetups check (2026-11-13) -> "a version that leaves the setup unreadable is refused
 *     at apply, not run on the built-in words" fails.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SETUP_DIR, applyLab, fnv1a, labCommand, labPlan, planText, readLabConfig, setFrontField, setupFieldsOf, setupFileFor } from "../lab.mjs";

const exec = promisify(execFile);
const FIXTURE = fileURLToPath(new URL("./fixtures/lab-config.json", import.meta.url));
const RUN = fileURLToPath(new URL("../run.mjs", import.meta.url));

/** A fresh copy of the fixture, so no test changes another's config. */
const fixture = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

/** A config with only what one test needs; everything else is missing, which the reader must default. */
const minimal = (extra = {}) => ({ texLab: 1, version: { name: "Tiny" }, ...extra });

/** A temp folder for one test; the bench copy lives under it where the real repo keeps it. */
async function tempTree() {
  return mkdtemp(join(tmpdir(), "lab-test-"));
}

/** Write the bench copy of the setup: production.md and a prompt module, as `pull` leaves them. */
async function benchCopy(root, { production = "---\nmodels:\n  main: anthropic/claude-haiku-5-5\n  advisor: anthropic/claude-opus-5-5\n---\n\nYou are Tex.\n", rules = "# Rules\n\nOld rules.\n" } = {}) {
  const setup = join(root, "apps/mcp/bench/ai", SETUP_DIR);
  await mkdir(join(setup, "prompt"), { recursive: true });
  await writeFile(join(setup, "production.md"), production);
  await writeFile(join(setup, "prompt/rules.md"), rules);
  return join(root, "apps/mcp/bench/ai");
}

// ---------------------------------------------------------------- fingerprints

test("the fingerprint is the Lab's FNV-1a 32-bit over UTF-16 code units", () => {
  assert.equal(fnv1a(""), "811c9dc5");
  assert.equal(fnv1a("a"), "e40c292c");
  assert.equal(fnv1a("foobar"), "bf9cf968");
  // The fixture's module fingerprints are real: the Lab computed them from these texts.
  assert.equal(fnv1a("# Rules\n\nBe brief. Never invent a fact.\n"), "acfea22b");
  assert.equal(fnv1a("Maya runs a small fashion brand."), "5b6914c6");
});

// ---------------------------------------------------------------- config validation

test("the reader takes the fixture as an object or as JSON text, and defaults missing lists and maps", () => {
  const fromText = readLabConfig(readFileSync(FIXTURE, "utf8"));
  const fromObject = readLabConfig(fixture());
  assert.deepEqual(fromText, fromObject);
  assert.equal(fromObject.version.name, "Faster reviewer");
  const bare = readLabConfig(minimal());
  assert.deepEqual(bare.steps, []);
  assert.deepEqual(bare.changes, []);
  assert.deepEqual(bare.wires, []);
  assert.deepEqual(bare.areas, []);
  assert.deepEqual(bare.caseEdits, []);
  assert.deepEqual(bare.setup, {});
  assert.deepEqual(bare.modules, {});
  assert.deepEqual(bare.models, {});
  assert.deepEqual(bare.cases, {});
});

test("a config that is not a Tex Lab config is refused with the reason", () => {
  assert.throws(() => readLabConfig("{not json"), /^Error: not a Tex Lab config: /);
  assert.throws(() => readLabConfig(minimal({ texLab: 2 })), /not a Tex Lab config: .*texLab/);
  assert.throws(() => readLabConfig({ version: { name: "x" } }), /not a Tex Lab config: .*texLab/);
  assert.throws(() => readLabConfig({ texLab: 1 }), /not a Tex Lab config: .*version\.name/);
  assert.throws(() => readLabConfig(minimal({ areas: "core" })), /not a Tex Lab config: .*areas/);
  assert.throws(() => readLabConfig(minimal({ setup: [] })), /not a Tex Lab config: .*setup/);
  assert.throws(() => readLabConfig(minimal({ cases: null })), /not a Tex Lab config: .*cases/);
});

test("area names are lowercase words with dashes, so a name cannot smuggle a path or a flag", () => {
  assert.doesNotThrow(() => readLabConfig(minimal({ areas: ["core", "advisor-chat"] })));
  assert.throws(() => readLabConfig(minimal({ areas: ["../core"] })), /not a Tex Lab config: .*area/);
  assert.throws(() => readLabConfig(minimal({ areas: ["Core"] })), /not a Tex Lab config: .*area/);
  assert.throws(() => readLabConfig(minimal({ areas: ["core --out x"] })), /not a Tex Lab config: .*area/);
});

test("module keys are word characters, colons and dashes only", () => {
  assert.doesNotThrow(() => readLabConfig(minimal({ modules: { "p-rules": { name: "Rules" }, "module:about": {} } })));
  assert.throws(() => readLabConfig(minimal({ modules: { "../x": {} } })), /not a Tex Lab config: .*module/);
  assert.throws(() => readLabConfig(minimal({ modules: { "a b": {} } })), /not a Tex Lab config: .*module/);
});

test("a module path that leaves ai/production is refused, and an absent path is fine", () => {
  const withPath = (path) => minimal({ modules: { m: { from: "ailc", path } } });
  assert.doesNotThrow(() => readLabConfig(withPath("ai/production/prompt/rules.md")));
  assert.doesNotThrow(() => readLabConfig(withPath("ai/production/skills/job-plan.md")));
  assert.doesNotThrow(() => readLabConfig(withPath("ai/production/texting-assistant.md")));
  assert.doesNotThrow(() => readLabConfig(minimal({ modules: { m: { from: "store" } } })));
  for (const path of ["../../secrets.md", "ai/production/../../secrets.md", "/etc/passwd.md", "ai/production/prompt/../x.md", "ai/production/prompt/..md", "ai/other/rules.md", "ai/production/prompt/rules.txt", "ai/production/prompt/sub/rules.md", "ai/production/prompt/rules.md\n../x.md"]) {
    assert.throws(() => readLabConfig(withPath(path)), /not a Tex Lab config: .*path/, path);
  }
});

// ---------------------------------------------------------------- where a note goes

test("a production note maps to its file in the bench copy of the setup, and anything else maps to nothing", () => {
  assert.equal(SETUP_DIR, "setups/texting-assistant");
  assert.equal(setupFileFor("ai/production/texting-assistant.md"), "setups/texting-assistant/production.md");
  assert.equal(setupFileFor("ai/production/prompt/rules.md"), "setups/texting-assistant/prompt/rules.md");
  assert.equal(setupFileFor("ai/production/skills/job-plan.md"), "setups/texting-assistant/skills/job-plan.md");
  assert.equal(setupFileFor("ai/production/other.md"), null);
  assert.equal(setupFileFor("ai/tests/core.md"), null);
  assert.equal(setupFileFor("ai/production/prompt/../rules.md"), null);
  assert.equal(setupFileFor(undefined), null);
});

// ---------------------------------------------------------------- the plan

test("the plan runs the examinable areas in config order and skips the rest with the reason", () => {
  const plan = labPlan(readLabConfig(fixture()));
  assert.deepEqual(plan.areas.run, ["core", "review"]);
  assert.equal(plan.areas.pipeline, false);
  assert.deepEqual(plan.areas.skipped, [{ area: "jobs", why: "needs API credits" }]);
});

test("pipeline is runnable and free, so it is named apart from the examiner's areas", () => {
  const plan = labPlan(readLabConfig(minimal({ areas: ["pipeline", "review"] })));
  assert.equal(plan.areas.pipeline, true);
  assert.deepEqual(plan.areas.run, ["review"]);
  assert.deepEqual(plan.areas.skipped, []);
});

test("setup fields go to production.md, module edits to their prompt file, and code and fixture changes are kept apart", () => {
  const plan = labPlan(readLabConfig(fixture()));
  assert.deepEqual(plan.setupFields, [
    { key: "models.main", value: "anthropic/claude-sonnet-5-5" },
    { key: "plan_big_asks", value: "on" },
  ]);
  assert.deepEqual(plan.moduleEdits, [
    {
      key: "p-rules",
      name: "Rules",
      file: "setups/texting-assistant/prompt/rules.md",
      text: "# Rules\n\nBe brief. Never invent a fact.\n",
      fingerprint: "acfea22b",
      mainFingerprint: null,
    },
  ]);
  assert.deepEqual(plan.codeChanges.map((change) => change.step), ["reviewer"]);
  // The `setup` change for the model is applied by the setup field, so it is not listed as code or fixture.
  assert.deepEqual(plan.fixtureChanges.map((change) => change.step), ["module:about"]);
  assert.deepEqual(plan.unapplied, []);
  assert.deepEqual(plan.cases, { review: ["r3", "r7"] });
  assert.equal(plan.caseEdits.length, 1);
  assert.equal(plan.version.name, "Faster reviewer");
});

test("a store module is a fixture change once, even when a fixture change already names it", () => {
  const config = minimal({
    changes: [{ step: "module:about", what: "context module changed", how: "fixture" }],
    modules: { about: { from: "store", text: "Maya runs a shop.", fingerprint: fnv1a("Maya runs a shop.") }, notes: { from: "store", text: "Fresh.", fingerprint: fnv1a("Fresh.") } },
  });
  const plan = labPlan(readLabConfig(config));
  assert.deepEqual(plan.fixtureChanges.map((change) => change.step), ["module:about", "module:notes"]);
});

test("code, built and special modules with text are listed as hand edits, never applied", () => {
  const config = minimal({
    modules: {
      tools: { from: "code", text: "Tool list.", fingerprint: fnv1a("Tool list.") },
      built: { from: "built", text: "Built.", fingerprint: fnv1a("Built.") },
      special: { from: "special", text: "Special.", fingerprint: fnv1a("Special.") },
      empty: { from: "code" },
    },
  });
  const plan = labPlan(readLabConfig(config));
  assert.deepEqual(plan.unapplied.map((module) => module.key), ["tools", "built", "special"]);
  assert.deepEqual(plan.moduleEdits, []);
});

test("warnings name a model change, a jobs ask and a module whose text changed after export", () => {
  const quiet = labPlan(readLabConfig(minimal({ areas: ["core"] })));
  assert.deepEqual(quiet.warnings, []);

  const named = labPlan(readLabConfig(fixture()));
  assert.ok(named.warnings.some((line) => line.includes("examiner answers as the named model: proves wiring, not quality")), named.warnings.join("\n"));
  assert.ok(named.warnings.some((line) => /jobs/.test(line)), named.warnings.join("\n"));
  assert.equal(named.warnings.some((line) => /fingerprint|changed after export/.test(line)), false);

  const drifted = labPlan(readLabConfig(minimal({ modules: { "p-rules": { from: "ailc", path: "ai/production/prompt/rules.md", text: "New text.\n", fingerprint: "00000000" } } })));
  assert.ok(drifted.warnings.some((line) => /p-rules/.test(line) && /changed after export/.test(line)), drifted.warnings.join("\n"));
});

test("the plan reads as short plain lines a person can check", () => {
  const text = planText(labPlan(readLabConfig(fixture())));
  for (const line of ["Faster reviewer", "core, review", "jobs", "models.main = anthropic/claude-sonnet-5-5", "setups/texting-assistant/prompt/rules.md", "reviewer", "examiner answers as the named model"]) {
    assert.ok(text.includes(line), `${line} is missing from:\n${text}`);
  }
  assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

// ---------------------------------------------------------------- front matter

const NOTE = "---\nmodels:\n  main: anthropic/claude-haiku-5-5\nname: Tex\n---\n\n# Body\n\nKeep every byte of this.\n";

test("setFrontField replaces a value in place and keeps every other byte", () => {
  assert.equal(setFrontField(NOTE, "models.main", "anthropic/claude-sonnet-5-5"), NOTE.replace("claude-haiku-5-5", "claude-sonnet-5-5"));
  assert.equal(setFrontField(NOTE, "name", "Faster"), NOTE.replace("name: Tex", "name: Faster"));
});

test("setFrontField adds a sub-key under its existing parent", () => {
  assert.equal(setFrontField(NOTE, "models.router", "anthropic/claude-haiku-5-5"), NOTE.replace("  main: anthropic/claude-haiku-5-5\n", "  main: anthropic/claude-haiku-5-5\n  router: anthropic/claude-haiku-5-5\n"));
});

test("setFrontField creates a missing parent and a missing top-level key at the end of the front matter", () => {
  const bare = "---\nname: Tex\n---\nbody\n";
  assert.equal(setFrontField(bare, "models.main", "x/y"), "---\nname: Tex\nmodels:\n  main: x/y\n---\nbody\n");
  assert.equal(setFrontField(bare, "plan_big_asks", "on"), "---\nname: Tex\nplan_big_asks: on\n---\nbody\n");
});

test("setFrontField keeps CRLF line endings and a body with odd bytes", () => {
  const crlf = "---\r\nmodels:\r\n  main: a\r\n---\r\nBody é \u{1F600}\r\n";
  assert.equal(setFrontField(crlf, "models.main", "b"), "---\r\nmodels:\r\n  main: b\r\n---\r\nBody é \u{1F600}\r\n");
  assert.equal(setFrontField(crlf, "models.router", "c"), "---\r\nmodels:\r\n  main: a\r\n  router: c\r\n---\r\nBody é \u{1F600}\r\n");
});

test("setFrontField refuses what it cannot write safely", () => {
  assert.throws(() => setFrontField("# no front matter\n", "name", "x"), /no front matter/);
  assert.throws(() => setFrontField(NOTE, "models.main.deep", "x"), /one level/);
  assert.throws(() => setFrontField(NOTE, "name", "two\nlines"), /newline/);
  // `models` has sub-keys, so setting it to one value would orphan them.
  assert.throws(() => setFrontField(NOTE, "models", "x"), /sub-keys/);
});

// ---------------------------------------------------------------- applying to the bench copy

test("apply writes the module text and the setup fields into the bench copy", async () => {
  const root = await tempTree();
  const benchDir = await benchCopy(root);
  const plan = labPlan(readLabConfig(fixture()));
  const applied = await applyLab(plan, { benchDir });
  assert.equal(await readFile(join(benchDir, SETUP_DIR, "prompt/rules.md"), "utf8"), "# Rules\n\nBe brief. Never invent a fact.\n");
  const production = await readFile(join(benchDir, SETUP_DIR, "production.md"), "utf8");
  assert.match(production, /main: anthropic\/claude-sonnet-5-5/);
  assert.match(production, /plan_big_asks: on/);
  assert.deepEqual(applied.map((entry) => entry.file), ["setups/texting-assistant/prompt/rules.md", "setups/texting-assistant/production.md", "setups/texting-assistant/production.md"]);
});

test("apply refuses a module whose bench copy drifted from main's, unless forced, and writes nothing", async () => {
  const root = await tempTree();
  const benchDir = await benchCopy(root, { rules: "# Rules\n\nSomeone edited this.\n" });
  const base = labPlan(readLabConfig(fixture()));
  const drifted = { ...base, moduleEdits: base.moduleEdits.map((edit) => ({ ...edit, mainFingerprint: fnv1a("# Rules\n\nWhat main had.\n") })) };
  const before = await readFile(join(benchDir, SETUP_DIR, "production.md"), "utf8");
  await assert.rejects(applyLab(drifted, { benchDir }), /setups\/texting-assistant\/prompt\/rules\.md is not main's copy any more .*pull the live setup again, or pass --force/);
  assert.equal(await readFile(join(benchDir, SETUP_DIR, "production.md"), "utf8"), before, "the setup fields are not written when a module refuses");
  assert.equal(await readFile(join(benchDir, SETUP_DIR, "prompt/rules.md"), "utf8"), "# Rules\n\nSomeone edited this.\n");

  const forced = await applyLab(drifted, { benchDir, force: true });
  assert.equal(forced[0].file, "setups/texting-assistant/prompt/rules.md");
  assert.equal(await readFile(join(benchDir, SETUP_DIR, "prompt/rules.md"), "utf8"), "# Rules\n\nBe brief. Never invent a fact.\n");
});

test("apply goes ahead when the bench copy is main's copy", async () => {
  const root = await tempTree();
  const current = "# Rules\n\nWhat main had.\n";
  const benchDir = await benchCopy(root, { rules: current });
  const base = labPlan(readLabConfig(fixture()));
  await applyLab({ ...base, moduleEdits: base.moduleEdits.map((edit) => ({ ...edit, mainFingerprint: fnv1a(current) })) }, { benchDir });
  assert.equal(await readFile(join(benchDir, SETUP_DIR, "prompt/rules.md"), "utf8"), "# Rules\n\nBe brief. Never invent a fact.\n");
});

test("apply adds a trailing newline only where the original had one", async () => {
  const withNewline = await tempTree();
  const benchA = await benchCopy(withNewline, { rules: "old\n" });
  const edit = (text) => ({ texLab: 1, moduleEdits: [{ key: "p", name: "P", file: "setups/texting-assistant/prompt/rules.md", text, fingerprint: fnv1a(text), mainFingerprint: null }], setupFields: [] });
  await applyLab(edit("new"), { benchDir: benchA });
  assert.equal(await readFile(join(benchA, SETUP_DIR, "prompt/rules.md"), "utf8"), "new\n");

  const withoutNewline = await tempTree();
  const benchB = await benchCopy(withoutNewline, { rules: "old" });
  await applyLab(edit("new"), { benchDir: benchB });
  assert.equal(await readFile(join(benchB, SETUP_DIR, "prompt/rules.md"), "utf8"), "new");
});

test("apply names the examiner's step 2 when the bench copy is missing", async () => {
  const root = await tempTree();
  const benchDir = join(root, "apps/mcp/bench/ai");
  await mkdir(benchDir, { recursive: true });
  await assert.rejects(applyLab(labPlan(readLabConfig(fixture())), { benchDir }), /docs\/testing\/examiner\.md step 2/);
});

test("a setup file cannot be written outside the setup folder", async () => {
  const written = [];
  const read = [];
  const plan = {
    setupFields: [],
    moduleEdits: [{ key: "evil", name: "Evil", file: "../../../../etc/passwd", text: "pwned\n", fingerprint: fnv1a("pwned\n"), mainFingerprint: null }],
  };
  const io = { readFile: async (path) => (read.push(path), "x"), writeFile: async (path) => written.push(path) };
  await assert.rejects(applyLab(plan, { benchDir: "/tmp/bench", ...io }), /outside/);
  await assert.rejects(applyLab({ ...plan, moduleEdits: [{ ...plan.moduleEdits[0], file: "/etc/passwd" }] }, { benchDir: "/tmp/bench", ...io }), /outside/);
  await assert.rejects(applyLab({ ...plan, moduleEdits: [{ ...plan.moduleEdits[0], file: "setups/texting-assistant/../../../../x.md" }] }, { benchDir: "/tmp/bench", ...io }), /outside/);
  assert.deepEqual(written, []);
  assert.deepEqual(read, []);
});

// ---------------------------------------------------------------- the command

/** A fake child process: records its arguments, writes the gate's `--out` file, and exits with `code`. */
function fakeGate({ code = 0, report = "Tex replay: nothing regressed", logLines = 2 } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    const out = args[args.indexOf("--out") + 1];
    const log = options.env.BENCH_STEP_LOG;
    setImmediate(async () => {
      await mkdir(join(out, ".."), { recursive: true });
      if (out) await writeFile(out, JSON.stringify({ pass: code === 0, usd: 0, report }));
      if (log) await writeFile(log, Array.from({ length: logLines }, (_, i) => `{"n":${i}}\n`).join(""));
      child.emit("close", code);
    });
    return child;
  };
  return { spawn, calls };
}

/** A temp repo with one commit, so `git rev-parse HEAD` has an answer. */
async function gitRepo(message) {
  const dir = await tempTree();
  const git = (args) => exec("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  await git(["init", "-q"]);
  await git(["commit", "-q", "--allow-empty", "-m", message]);
  return dir;
}

async function configFile(root, config = fixture()) {
  const file = join(root, "lab.json");
  await writeFile(file, JSON.stringify(config));
  return file;
}

test("lab run starts the gate with the examinable areas, the socket and the step log, and streams its report", async () => {
  const root = await tempTree();
  const cwd = await gitRepo("branch");
  const base = await gitRepo("main");
  const bench = await benchCopy(cwd);
  const scratch = join(root, "scratch");
  const socket = join(root, "socket");
  const config = await configFile(root, fixture());
  const { spawn, calls } = fakeGate({ logLines: 3 });
  const out = [];
  // The fixture's code change is in the tree, and the branch's HEAD is not main's, so the refusal does not apply.
  await labCommand({ job: "run", config, base, socket, scratch, "held-out": join(root, "held") }, { spawn, cwd, out: (text) => out.push(text) });

  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args, ["apps/mcp/bench/run.mjs", "gate", "--base", base, "--areas", "core,review", "--held-out", join(root, "held"), "--scratch", scratch, "--out", join(scratch, "lab-gate.json")]);
  assert.equal(options.cwd, cwd);
  assert.equal(options.env.BENCH_MODEL_SOCKET, socket);
  assert.equal(options.env.BENCH_STEP_LOG, join(scratch, "lab-steps.jsonl"));
  assert.equal(options.env.BENCH_LAB_BRANCH, cwd);
  // Clef and GLM come to the socket to be run for real through Context, and main's tree is named so its lines are main's.
  assert.equal(options.env.BENCH_MODEL_SOCKET_KINDS, process.env.BENCH_MODEL_SOCKET_KINDS || "claude,workers-ai");
  assert.equal(options.env.BENCH_LAB_REAL_MODELS, "1");
  assert.equal(options.env.BENCH_LAB_MAIN, base);
  // The bench copy was written before the gate ran.
  assert.match(await readFile(join(bench, SETUP_DIR, "production.md"), "utf8"), /main: anthropic\/claude-sonnet-5-5/);

  const text = out.join("");
  assert.match(text, /## Lab run: Faster reviewer/);
  assert.match(text, /Tex replay: nothing regressed/);
  assert.match(text, new RegExp(`Step log: ${join(scratch, "lab-steps.jsonl").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(3 lines\\)`));
});

test("lab run without a held-out folder passes no --held-out flag", async () => {
  const root = await tempTree();
  const cwd = await gitRepo("branch");
  const base = await gitRepo("main");
  await benchCopy(cwd);
  const { spawn, calls } = fakeGate();
  await labCommand({ job: "run", config: await configFile(root), base, socket: join(root, "s"), scratch: join(root, "scratch") }, { spawn, cwd, out: () => {} });
  assert.equal(calls[0].args.includes("--held-out"), false);
});

test("lab run refuses a plan with no examinable area, before it writes anything", async () => {
  const root = await tempTree();
  const cwd = await gitRepo("branch");
  const base = await gitRepo("main");
  const bench = await benchCopy(cwd);
  const before = await readFile(join(bench, SETUP_DIR, "production.md"), "utf8");
  const config = await configFile(root, minimal({ areas: ["jobs"], setup: { plan_big_asks: "on" } }));
  const { spawn, calls } = fakeGate();
  await assert.rejects(labCommand({ job: "run", config, base, socket: join(root, "s") }, { spawn, cwd, out: () => {} }), /no area the examiner can run/);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(join(bench, SETUP_DIR, "production.md"), "utf8"), before);
});

test("lab run refuses code changes on an unchanged tree unless forced", async () => {
  const root = await tempTree();
  const cwd = await gitRepo("same");
  const config = await configFile(root, fixture());
  const { spawn, calls } = fakeGate();
  // The base is the same commit as the branch: the reviewer's code change was never built.
  await assert.rejects(labCommand({ job: "run", config, base: cwd, socket: join(root, "s"), scratch: join(root, "scratch") }, { spawn, cwd, out: () => {} }), /not built/);
  assert.equal(calls.length, 0);

  await benchCopy(cwd);
  await labCommand({ job: "run", config, base: cwd, socket: join(root, "s"), scratch: join(root, "scratch"), force: true }, { spawn, cwd, out: () => {} });
  assert.equal(calls.length, 1, "--force runs anyway");
  // A branch whose HEAD differs from main's is not refused (covered by the run test above, which uses another repo).
});

test("lab run exits non-zero when the gate fails, and still prints its report", async () => {
  const root = await tempTree();
  const cwd = await gitRepo("branch");
  const base = await gitRepo("main");
  await benchCopy(cwd);
  const before = process.exitCode;
  try {
    const { spawn } = fakeGate({ code: 1, report: "Tex replay: 1 case(s) regressed" });
    const out = [];
    await labCommand({ job: "run", config: await configFile(root), base, socket: join(root, "s"), scratch: join(root, "scratch") }, { spawn, cwd, out: (text) => out.push(text) });
    assert.match(out.join(""), /1 case\(s\) regressed/);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = before;
  }
});

test("lab plan prints the plan and changes nothing, and an unknown or missing subcommand is refused", async () => {
  const root = await tempTree();
  const cwd = root;
  await benchCopy(root);
  const out = [];
  await labCommand({ job: "plan", config: await configFile(root) }, { cwd, out: (text) => out.push(text) });
  assert.match(out.join(""), /Faster reviewer/);
  await assert.rejects(labCommand({ job: "nope", config: await configFile(root) }, { cwd, out: () => {} }), /usage: pnpm ai lab/);
  await assert.rejects(labCommand({ job: "plan" }, { cwd, out: () => {} }), /--config/);
});

test("run.mjs lists the lab command in its usage", async () => {
  const error = await exec(process.execPath, [RUN, "no-such-command"]).then(() => "", (failed) => failed.stderr);
  assert.match(error, /pnpm ai lab plan\|apply\|run --config <lab config\.json>/);
});

test("a lab config file that is not a Tex Lab config stops the command before anything runs", async () => {
  const root = await tempTree();
  const file = join(root, "bad.json");
  await writeFile(file, JSON.stringify({ texLab: 2, version: { name: "x" } }));
  const { spawn, calls } = fakeGate();
  await assert.rejects(labCommand({ job: "run", config: file, base: "/nope", socket: join(root, "s") }, { spawn, cwd: root, out: () => {} }), /not a Tex Lab config/);
  assert.equal(calls.length, 0);
});

test("the Lab's switches become what the setup reads: a router by its model, off as no line, a new prompt order as modules.texts", () => {
  const warnings = [];
  const fields = setupFieldsOf(
    readLabConfig(
      minimal({
        setup: { "models.router": "on", plan_big_asks: "off", "ai/production/texting-assistant.md modules:": "Rules → Tools", "weird key!": "x", "models.main": "anthropic/claude-haiku-5-5" },
        steps: [{ id: "fd", reads: ["tools", "p-rules", "hist", "p-about-tex"] }],
      }),
    ),
    warnings,
  );
  assert.deepEqual(fields, [
    { key: "models.router", value: "@cf/cloudflare/clef" },
    { key: "plan_big_asks", value: null },
    { key: "modules.texts", value: "[rules, about-tex]" },
    { key: "models.main", value: "anthropic/claude-haiku-5-5" },
  ]);
  assert.deepEqual(warnings, ['setup "weird key!" is not a front-matter field, so it is not applied']);
  assert.deepEqual(setupFieldsOf(readLabConfig(minimal({ setup: { "models.router": "off" } }))), [{ key: "models.router", value: null }]);
});

test("a field set to nothing is removed, with its parent when it was the last sub-key, and every other byte kept", () => {
  const note = "---\nmodels:\n  main: a/b\n  router: @cf/cloudflare/clef\nplan_big_asks: on\n---\nbody\n";
  assert.equal(setFrontField(note, "plan_big_asks", null), "---\nmodels:\n  main: a/b\n  router: @cf/cloudflare/clef\n---\nbody\n");
  assert.equal(setFrontField(note, "models.router", null), "---\nmodels:\n  main: a/b\nplan_big_asks: on\n---\nbody\n");
  assert.equal(setFrontField("---\nmodels:\n  router: x\nname: T\n---\n", "models.router", null), "---\nname: T\n---\n");
  assert.equal(setFrontField(note, "absent", null), note, "removing a missing field changes nothing");
});

test("a version that leaves the setup unreadable is refused at apply, not run on the built-in words", async () => {
  const root = await tempTree();
  const bench = await benchCopy(root, { production: "---\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are Tex.\n" });
  // plan_big_asks needs models.advisor (`production.js`): the product would refuse this setup and fall back.
  const plan = labPlan(minimal({ areas: ["core"], setup: { plan_big_asks: "on" } }));
  const { readSetups } = await import("../run.mjs");
  await assert.rejects(applyLab(plan, { benchDir: bench, validate: (dir) => readSetups(dir, "texting-assistant", ["production"]) }), /no longer reads as a setup/);
});
