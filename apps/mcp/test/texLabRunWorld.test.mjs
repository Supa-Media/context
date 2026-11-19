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

const WORKFLOW_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".github", "workflows", "tex-lab-run.yml");
const TEXT = readFileSync(WORKFLOW_PATH, "utf8");

/** A step's block of a workflow's text: its `- name:` line up to the next step or job, or "" when there is none. */
export function stepOf(text, name) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at < 0) return "";
  const indent = lines[at].indexOf("-");
  let end = at + 1;
  while (end < lines.length && !(lines[end].trim() !== "" && lines[end].search(/\S/) <= indent && !lines[end].trim().startsWith("#"))) end += 1;
  return lines.slice(at, end).join("\n");
}
/** The workflow_dispatch input `name`'s block. */
const inputOf = (text, name) => (text.match(new RegExp(`\\n      ${name}:\\n((?:        .*\\n|          .*\\n)+)`)) ?? [])[1] ?? "";
const runStep = stepOf(TEXT, "Run the Dev set's unit tests");
const uploadStep = stepOf(TEXT, "Upload the recorded world");

test("workflow: the world input exists, defaults to replay, and offers exactly replay, record and refresh", () => {
  const input = inputOf(TEXT, "world");
  assert.ok(input, "the world input is declared");
  assert.match(input, /type: choice/);
  assert.match(input, /default: replay\n/);
  assert.match(input, /options:\n\s+- replay\n\s+- record\n\s+- refresh\n/);
  assert.match(runStep, /WORLD: \$\{\{ inputs\.world \|\| 'replay' \}\}/);
});

test("workflow: the run step validates the mode, replays the handed-in conversations with a strict warn, and runs record and refresh on the set", () => {
  const script = runStep;
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
  assert.doesNotMatch(script.replace(/^\s*#.*$/gm, ""), /sets run --conversations[^\n]*--world (record|refresh)/, "no record on a file");
});

test("workflow: the upload step runs on record and refresh only, right after the run step, and keeps the fixtures", () => {
  assert.ok(uploadStep, "the upload step exists");
  assert.match(uploadStep, /if: always\(\) && \(inputs\.world == 'record' \|\| inputs\.world == 'refresh'\)/);
  assert.match(uploadStep, /uses: actions\/upload-artifact@v4\n/);
  assert.match(uploadStep, /name: world-fixtures/);
  assert.match(uploadStep, /path: apps\/mcp\/bench\/sets\/sim\/\n/);
  const run = TEXT.indexOf("- name: Run the Dev set's unit tests");
  const upload = TEXT.indexOf("- name: Upload the recorded world");
  const between = TEXT.slice(run + 1, upload);
  assert.ok(run > 0 && upload > run && !/- name: /.test(between), "right after the run step");
});

// The standalone recorder (`.github/workflows/tex-world-record.yml`): the repo's Training or Dev set only, fd, never a
// handed-in file; replay warns on a miss and prints the world's hash (`bench/worldHash.mjs`).
const RECORD = readFileSync(join(dirname(WORKFLOW_PATH), "tex-world-record.yml"), "utf8");

test("record workflow: only Training or Dev, through --set, and its fixtures uploaded only when it wrote them", () => {
  assert.match(inputOf(RECORD, "set"), /options:\n\s+- training\n\s+- dev\n/);
  assert.match(inputOf(RECORD, "world"), /options:\n\s+- record\n\s+- refresh\n\s+- replay\n/);
  const run = stepOf(RECORD, "Run the set's Front door tests");
  assert.match(run, /\[\[ "\$SET" =~ \^\(training\|dev\)\$ \]\]/);
  assert.match(run, /sets run --set "\$SET" --node fd --world "\$WORLD"/);
  assert.doesNotMatch(run, /--conversations/);
  assert.match(run, /--world-strict warn/);
  assert.match(run, /worldHash\.mjs/);
  const upload = stepOf(RECORD, "Upload the recorded world");
  assert.match(upload, /if: always\(\) && inputs\.world != 'replay'/);
  // Only the set's own files are uploaded, so a concurrent recording of the other set is never overwritten.
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/world-out\/\n/);
  assert.match(run, /for conv in apps\/mcp\/bench\/sets\/"\$SET"\/\*\.json/);
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

test("worldHash: every world event on a Browser line counts, other events do not", async () => {
  const { worldLines } = await import("../bench/worldHash.mjs");
  const line = 'Browser: open https://a.example | world web search {"query":"x"} -> {} | world browser page (replayed) {"open":"y"} -> {}';
  assert.deepEqual(worldLines(`Tex: hi\n${line}\n`), ['world web search {"query":"x"} -> {}', 'world browser page {"open":"y"} -> {}']);
  assert.deepEqual(worldLines("world web search {} -> {}\n"), [], "only the Browser line is read");
});

test("record workflow: the push job holds the write token, none of the run's secrets, and only writes tex-world/ or claude/ branches", () => {
  const push = RECORD.slice(RECORD.indexOf("\n  push:\n"));
  assert.ok(push.length > 10, "a push job");
  assert.doesNotMatch(push, /secrets\./, "the push job sees no secret");
  assert.match(push, /contents: write/);
  assert.match(push, /\^\(tex-world\|claude\)\//);
  assert.match(push, /inputs\.world != 'replay' && inputs\.branch != ''/);
  const run = RECORD.slice(RECORD.indexOf("\n  run:\n"), RECORD.indexOf("\n  push:\n"));
  assert.doesNotMatch(run, /contents: write/, "the job with the model secrets never writes");
});
