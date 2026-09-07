#!/usr/bin/env node
/**
 * Syntax-check every `run:` block in every workflow.
 *
 * These blocks are shell scripts that frequently embed JavaScript via
 * `node -e '…'`. A single apostrophe inside that JavaScript closes the shell's
 * quote early and the rest of the program is handed to bash, which fails with
 * something like:
 *
 *   syntax error near unexpected token `('
 *
 * That shipped: `"this Worker's deliberately uniform refusals"` broke the email
 * deploy's routing check. It went unnoticed because an earlier step in the same
 * script always failed first, so the broken half never ran — a reminder that a
 * step which never executes is not a step that works.
 *
 * `bash -n` parses without executing, so this is cheap and side-effect free.
 */
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
  Resolved from this file rather than the working directory — same bug and same
  fix as `check-workflow-yaml.mjs` and `check-workflow-triggers.mjs`. The
  relative form works only because CI runs from the repo root; anywhere else it
  is an ENOENT stack trace about `scandir`, which reads as "the tool is broken"
  rather than "the tree is wrong".
*/
const dir = fileURLToPath(new URL("../.github/workflows", import.meta.url));
const problems = [];

/** Minimal YAML reach-in: we only need `run:` blocks, not a full parse. */
function runBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-?\s*run:\s*\|\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() !== "" && line.search(/\S/) <= indent) break;
      body.push(line);
    }
    blocks.push({ line: i + 1, body: body.join("\n") });
    i = j - 1;
  }
  return blocks;
}

for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
  const text = readFileSync(join(dir, file), "utf8");
  for (const { line, body } of runBlocks(text)) {
    const res = spawnSync("bash", ["-n"], { input: body, encoding: "utf8" });
    if (res.status !== 0) {
      problems.push(`${file}:${line}\n${(res.stderr || "").trim()}`);
    }
  }
}

if (problems.length > 0) {
  console.error("Shell syntax errors in workflow run blocks:\n");
  for (const p of problems) console.error(p + "\n");
  console.error("A stray apostrophe inside an embedded node -e '…' is the usual cause.");
  process.exit(1);
}
console.log("OK — every workflow run block parses as shell.");
