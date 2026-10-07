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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const unit = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts["test:unit"];
if (!/^node --test \S/.test(unit ?? "")) throw new Error("package.json test:unit is not `node --test <files>`");

const ENTRIES = [
  ["test.mjs", ["test/test.mjs"]],
  ["bulkMoves.mjs move", ["test/bulkMoves.mjs", "move"]],
  ["bulkMoves.mjs folder", ["test/bulkMoves.mjs", "folder"]],
  ["node --test", unit.split(/\s+/).slice(1)],
];

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

const results = await Promise.all(ENTRIES.map(run));
for (const { name, ok, output, detail, seconds } of results) {
  process.stdout.write(`\n===== ${name} (${detail}, ${seconds}s) =====\n`);
  process.stdout.write(Buffer.concat(output));
  if (!ok) process.stdout.write(`\n${name} FAILED (${detail})\n`);
}
const failed = results.filter((result) => !result.ok).map((result) => result.name);
console.log(failed.length ? `\nFAILED: ${failed.join(", ")}` : `\nAll ${results.length} gateway test entry points passed.`);
process.exitCode = failed.length ? 1 : 0;
