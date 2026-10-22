/**
 * `pnpm test`: every gateway test entry point, at the same time.
 *
 * They used to run one after another (`node test/test.mjs && node --test …`).
 * None shares state with another — each is its own process — so running them
 * side by side changes nothing but the wall time, which becomes the slowest
 * one's rather than the sum. Each one's output is printed whole when it ends,
 * so the log reads the same as before, and the run fails if any of them does:
 * a non-zero exit, a signal, or an entry that never started all count.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The `node --test` files, one path per line. They lived on one line of
// package.json's `test:unit`, so any two branches that each added a test
// conflicted there; a line per file is merged by git on its own
// (`merge=union` in .gitattributes), and a duplicate a union leaves is dropped.
const unit = [...new Set(readFileSync(join(ROOT, "test/unit.list"), "utf8").split("\n").map((line) => line.trim()).filter(Boolean))];
const missing = unit.filter((file) => !existsSync(join(ROOT, file)));
if (!unit.length || missing.length) throw new Error(`test/unit.list names files that do not exist: ${missing.join(", ") || "(empty list)"}`);

// test/isolated.mjs's suites, split across this many processes (see its header).
const ISOLATED_SHARDS = 3;
const ENTRIES = [
  ["test.mjs", ["test/test.mjs"]],
  ...Array.from({ length: ISOLATED_SHARDS }, (_, shard) => [
    `isolated.mjs ${shard + 1}/${ISOLATED_SHARDS}`,
    ["test/isolated.mjs", String(shard), String(ISOLATED_SHARDS)],
  ]),
  ["bulkMoves.mjs move", ["test/bulkMoves.mjs", "move"]],
  ["bulkMoves.mjs folder", ["test/bulkMoves.mjs", "folder"]],
  ["node --test", ["--test", ...unit]],
];
// `pnpm test:unit` (`run.mjs unit`) runs the `node --test` entry alone, and
// `run.mjs integration` runs every other one. CI runs the two halves as two
// jobs on two runners: on one, all of them together are bound by its four
// cores, not by the slowest entry.
const MODES = {
  unit: ([name]) => name === "node --test",
  integration: ([name]) => name !== "node --test",
};
const mode = process.argv[2];
if (mode !== undefined && !MODES[mode]) throw new Error(`run.mjs takes no argument, "unit" or "integration", not ${JSON.stringify(mode)}`);
const only = mode ? ENTRIES.filter(MODES[mode]) : ENTRIES;

function run([name, args]) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    const done = (ok, detail) => resolve({ name, ok, output, detail, seconds: Math.round((Date.now() - started) / 1000) });
    child.on("error", (error) => done(false, error.message));
    child.on("close", (code, signal) => done(code === 0, signal ? `signal ${signal}` : `exit ${code}`));
  });
}

const results = await Promise.all(only.map(run));
for (const { name, ok, output, detail, seconds } of results) {
  process.stdout.write(`\n===== ${name} (${detail}, ${seconds}s) =====\n`);
  process.stdout.write(Buffer.concat(output));
  if (!ok) process.stdout.write(`\n${name} FAILED (${detail})\n`);
}
const failed = results.filter((result) => !result.ok).map((result) => result.name);
console.log(failed.length ? `\nFAILED: ${failed.join(", ")}` : `\nAll ${results.length} gateway test entry points passed.`);
process.exitCode = failed.length ? 1 : 0;
