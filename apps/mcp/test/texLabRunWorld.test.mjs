/**
 * The Lab run workflow's world input (`.github/workflows/tex-lab-run.yml`; `bench/setsRun.mjs` --world, --world-strict).
 * Replay runs the handed-in conversations and warns on a miss; record and refresh run the set itself, never a handed-in
 * file, and upload the recorded fixtures for a person to commit. The workflow is parsed as YAML, as
 * scripts/lab-runner-lease.test.mjs parses it.
 *
 * Sabotage: a replay branch without `--world-strict warn`, a record branch given `--conversations`, or an upload step
 * without its `if` fails these.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const WORKFLOW_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".github", "workflows", "tex-lab-run.yml");
const WORKFLOW = parse(readFileSync(WORKFLOW_PATH, "utf8"));
const runJob = WORKFLOW.jobs.run;
const runStep = runJob.steps.find((s) => s.name === "Run the Dev set's unit tests");
const uploadStep = runJob.steps.find((s) => s.name === "Upload the recorded world");

test("workflow: the world input exists, defaults to replay, and offers exactly replay, record and refresh", () => {
  const input = WORKFLOW.on.workflow_dispatch.inputs.world;
  assert.ok(input, "the world input is declared");
  assert.equal(input.type, "choice");
  assert.equal(String(input.default), "replay");
  assert.deepEqual(input.options, ["replay", "record", "refresh"]);
  assert.equal(runStep.env.WORLD, "${{ inputs.world || 'replay' }}");
});

test("workflow: the run step validates the mode, replays the handed-in conversations with a strict warn, and runs record and refresh on the set", () => {
  const script = runStep.run;
  assert.match(script, /\[\[ "\$WORLD" =~ \^\(replay\|record\|refresh\)\$ \]\]/);
  const replay = script.match(/if \[ "\$WORLD" = "replay" \]; then\n([\s\S]*?)\n\s*else\n([\s\S]*?)\n\s*fi/);
  assert.ok(replay, "a replay branch and an else branch");
  const [, replayBranch, otherBranch] = replay;
  assert.match(replayBranch, /--conversations "\$RUNNER_TEMP\/lab\/convs\.json"/);
  assert.match(replayBranch, /--world replay/);
  assert.match(replayBranch, /--world-strict warn/);
  assert.match(otherBranch, /--set "\$SET" --world "\$WORLD"/);
  assert.doesNotMatch(otherBranch, /--conversations/, "record and refresh never run on a handed-in file");
  assert.doesNotMatch(otherBranch, /--world-strict/, "a record or refresh never warns");
  assert.match(script, /node apps\/mcp\/bench\/run\.mjs sets run "\$\{scope\[@\]\}" "\$\{args\[@\]\}"/, "both branches share the flags through one command");
  assert.match(script, /args=\(--out "\$RUNNER_TEMP\/lab\/rows\.json" --parallel 8 --repeat "\$\{REPEATS:-3\}" --keep "\$RUNNER_TEMP\/lab\/kept"\)/);
  assert.doesNotMatch(script.replace(/^\s*#.*$/gm, ""), /sets run --conversations[^\n]*--world (record|refresh)/, "no record on a file");
});

test("workflow: the upload step exists, runs on record and refresh only, and keeps the recorded fixtures for a person to commit", () => {
  assert.ok(uploadStep, "the upload step exists");
  assert.equal(uploadStep.if, "always() && (inputs.world == 'record' || inputs.world == 'refresh')");
  assert.match(uploadStep.uses, /^actions\/upload-artifact@v4$/);
  assert.equal(uploadStep.with.name, "world-fixtures");
  assert.equal(uploadStep.with.path, "apps/mcp/bench/sets/sim/");
  assert.equal(uploadStep.with["retention-days"], 7);
  assert.equal(uploadStep.with["if-no-files-found"], "warn");
  const order = runJob.steps.map((s) => s.name);
  assert.ok(order.indexOf("Upload the recorded world") === order.indexOf("Run the Dev set's unit tests") + 1, "right after the run step");
});

// The standalone recorder (`.github/workflows/tex-world-record.yml`): the repo's Training or Dev set only, fd, never a
// handed-in file; replay warns on a miss and prints the world's hash (`bench/worldHash.mjs`).
const RECORD = parse(readFileSync(join(dirname(WORKFLOW_PATH), "tex-world-record.yml"), "utf8"));

test("record workflow: only Training or Dev, through --set, and its fixtures uploaded only when it wrote them", () => {
  const inputs = RECORD.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.set.options, ["training", "dev"]);
  assert.deepEqual(inputs.world.options, ["record", "refresh", "replay"]);
  const steps = RECORD.jobs.run.steps;
  const run = steps.find((s) => s.name === "Run the set's Front door tests");
  assert.match(run.run, /\[\[ "\$SET" =~ \^\(training\|dev\)\$ \]\]/);
  assert.match(run.run, /sets run --set "\$SET" --node fd --world "\$WORLD"/);
  assert.doesNotMatch(run.run, /--conversations/);
  assert.match(run.run, /--world-strict warn/);
  assert.match(run.run, /worldHash\.mjs/);
  const upload = steps.find((s) => s.name === "Upload the recorded world");
  assert.equal(upload.if, "always() && inputs.world != 'replay'");
  assert.equal(upload.with.path, "apps/mcp/bench/sets/sim/");
});

test("worldHash: a replayed answer and the same answer first asked hash the same; a different answer does not", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { worldHash, conversationOf } = await import("../bench/worldHash.mjs");
  assert.equal(conversationOf("c2-loose-ends-sets-11"), "loose-ends");
  const write = (lines) => {
    const dir = mkdtempSync(join(tmpdir(), "world-hash-"));
    mkdirSync(join(dir, "c1-a-sets-1"));
    writeFileSync(join(dir, "c1-a-sets-1", "result.md"), `Tex: hi\n${lines.join("\n")}\n`);
    return dir;
  };
  const asked = worldHash(write(['Browser: world web search {"query":"x"} -> {"results":[]}']));
  const replayed = worldHash(write(['Browser: world web search (replayed) {"query":"x"} -> {"results":[]}']));
  const other = worldHash(write(['Browser: world web search {"query":"x"} -> {"results":[1]}']));
  assert.equal(asked.answers, 1);
  assert.equal(asked.hash, replayed.hash);
  assert.notEqual(asked.hash, other.hash);
});
