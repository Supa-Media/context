#!/usr/bin/env node
/**
 * NOTHING JOINS TEX'S REPLY PATH UNTIMED (Dev2, 2026-11-01: "add a hook that
 * anything that wants to add to Tex entry point must add proper logging, so
 * that we are never guessing").
 *
 * Code between `// TEX ENTRY POINT: begin` and `// TEX ENTRY POINT: end`
 * (the gateway's `agentTurn`, `apps/mcp/src/agent/route.js`, and the texting
 * Worker's reply path, `apps/agent/src`) is the path a text takes to its
 * answer. Every `await` in there must await a timed call of the entry point
 * (`await tex.step("name", ...)`, `tex.wait`, `tex.ahead`, `tex.after`,
 * `tex.behind`), and every step is named with a string literal, so each one
 * shows by name in `tex_entry` (`texEntryPoint.js`, `texEntryPoint.ts`).
 *
 * Usage:
 *   node scripts/tex-entry-check.mjs            check the repository's files
 *   node scripts/tex-entry-check.mjs --self-test
 *   node scripts/tex-entry-check.mjs --hook     Claude Code PostToolUse hook: reads the tool call on stdin,
 *                                                checks the edited file, exit 2 tells the agent what to fix
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BEGIN = "// TEX ENTRY POINT: begin";
const END = "// TEX ENTRY POINT: end";
/** Where entry-point regions may live; every file here is scanned. */
const SCANNED = ["apps/mcp/src/agent", "apps/agent/src"];
/** Each file that must hold a region: the reply path cannot quietly lose its markers. */
const REQUIRED = ["apps/mcp/src/agent/route.js", "apps/agent/src/inbox.ts"];

const TIMED = /^await\s+tex\.(step|wait|ahead|after|behind)\(/;
const STEP = /\btex\.(step|wait|ahead|after)\(/g;
/** A step's name: a snake_case string, or a choice of two (`group !== null ? "a" : "b"`). */
const NAME = /^(?:"[a-z0-9_:]+"|[a-z]+ !== null \? "[a-z0-9_:]+" : "[a-z0-9_:]+")$/;

/** The problems in one file's text, as `line: message`, and how many regions it has. */
export function checkSource(source) {
  const problems = [];
  const lines = source.split("\n");
  let inside = false;
  let regions = 0;
  for (const [index, line] of lines.entries()) {
    const at = index + 1;
    if (line.includes(BEGIN)) {
      if (inside) problems.push(`${at}: a second "${BEGIN}" before the "${END}"`);
      inside = true;
      regions += 1;
      continue;
    }
    if (line.includes(END)) {
      if (!inside) problems.push(`${at}: "${END}" with no begin`);
      inside = false;
      continue;
    }
    if (!inside) continue;
    const code = masked(line);
    for (const match of code.matchAll(/\bawait\b/g)) {
      if (!TIMED.test(code.slice(match.index))) problems.push(`${at}: an untimed await; wrap it as \`await tex.step("what_it_does", () => ...)\` (texEntryPoint)`);
    }
    for (const match of code.matchAll(STEP)) {
      const from = match.index + match[0].length;
      const stop = code.slice(from).search(/[,)]/);
      const name = line.slice(from, stop === -1 ? undefined : from + stop).trim();
      if (!NAME.test(name)) problems.push(`${at}: step named ${name || "(nothing)"}; name it with a snake_case string, so it shows by name`);
    }
  }
  if (inside) problems.push(`${lines.length}: "${BEGIN}" never ends`);
  return { problems, regions };
}

/** The line with any // comment cut and every string's contents blanked, so positions still match the line. */
function masked(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === "\\") {
        out += "  ";
        i += 1;
      } else if (c === quote) {
        quote = null;
        out += c;
      } else out += " ";
      continue;
    }
    if (c === "/" && line[i + 1] === "/") break;
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
  }
  return out;
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(js|ts|mjs)$/.test(entry) && !/\.test\.|\.testing\./.test(entry)) out.push(path);
  }
  return out;
}

export function checkRepository(root = ROOT) {
  const problems = [];
  for (const dir of SCANNED) {
    for (const path of filesUnder(join(root, dir))) {
      const { problems: found, regions } = checkSource(readFileSync(path, "utf8"));
      const name = relative(root, path);
      for (const problem of found) problems.push(`${name}:${problem}`);
      if (REQUIRED.includes(name) && regions === 0) problems.push(`${name}: the reply path lost its "${BEGIN}" marker`);
    }
  }
  return problems;
}

function selfTest() {
  const ok = checkSource(`x\n${BEGIN}\nconst a = await tex.step("read", () => r());\nconst b = await tex.wait("read", p); // await in a comment\nconst c = "await in a string";\nconst d = tex.ahead(group !== null ? "group_read" : "read", () => r());\n${END}\nawait free();\n`);
  if (ok.problems.length !== 0 || ok.regions !== 1) throw new Error(`self-test: a timed region was refused: ${ok.problems.join("; ")}`);
  const bare = checkSource(`${BEGIN}\nconst a = await read();\n${END}\n`);
  if (bare.problems.length !== 1) throw new Error("self-test: a bare await passed");
  const unnamed = checkSource(`${BEGIN}\nconst a = await tex.step(name, () => read());\n${END}\n`);
  if (unnamed.problems.length !== 1) throw new Error("self-test: a step named by a variable passed");
  const open = checkSource(`${BEGIN}\nconst a = 1;\n`);
  if (open.problems.length !== 1) throw new Error("self-test: a region that never ends passed");
  const nested = checkSource(`${BEGIN}\nconst a = await tex.step("outer", async () => keep(await hear()));\n${END}\n`);
  if (nested.problems.length !== 1) throw new Error("self-test: an untimed await inside a step passed");
  console.log("tex-entry-check: self-test passed");
}

async function hook() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let path = "";
  try {
    const call = JSON.parse(input);
    path = call?.tool_input?.file_path ?? call?.tool_input?.path ?? "";
  } catch {
    return;
  }
  if (typeof path !== "string" || !/\.(js|ts|mjs)$/.test(path)) return;
  const name = relative(ROOT, resolve(path));
  if (!SCANNED.some((dir) => name.startsWith(`${dir}/`))) return;
  let source;
  try {
    source = readFileSync(resolve(path), "utf8");
  } catch {
    return;
  }
  const { problems, regions } = checkSource(source);
  if (REQUIRED.includes(name) && regions === 0) problems.push(`the reply path lost its "${BEGIN}" marker`);
  if (problems.length === 0) return;
  process.stderr.write(`Tex entry point: every step on the reply path is timed by name (scripts/tex-entry-check.mjs).\n${problems.map((p) => `${name}:${p}`).join("\n")}\n`);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else if (process.argv.includes("--hook")) await hook();
  else {
    const problems = checkRepository();
    if (problems.length > 0) {
      console.error(`tex-entry-check: ${problems.length} untimed step(s) on Tex's reply path:\n${problems.join("\n")}`);
      process.exit(1);
    }
    console.log("tex-entry-check: every step on Tex's reply path is timed");
  }
}
