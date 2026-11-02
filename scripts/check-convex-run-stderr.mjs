#!/usr/bin/env node
/**
 * THIS REPOSITORY IS PUBLIC, AND SO IS EVERY WORKFLOW LOG.
 *
 * `npx convex run` writes the function's own `console.*` output to **stderr**,
 * not stdout. The Convex CLI's `runFunctionAndLog` builds its HTTP client with
 * a stderr logger and the client sets `debug = true` unconditionally, so every
 * log line the function emitted comes back over the wire and is printed:
 *
 *     if (this.debug) for (const line of respJSON.logLines ?? [])
 *       logForFunction(this.logger, "info", "action", name, line);
 *
 * The result itself goes to stdout, which is why `answer=$(npx convex run …)`
 * parses as JSON. Capturing stdout therefore does **not** capture the log
 * lines: they flow straight into the job log, where anyone can read them.
 *
 * Our migration and backfill functions log a workspace id with every failure —
 * deliberately, for the Convex dashboard, which is private. One of them,
 * `tex-history-migration.yml`, exists to print exactly that set of workspaces
 * *only* sealed to the operator's own RSA key. The same ids were arriving in
 * the clear one stream over.
 *
 * So: every `npx convex run` in a workflow sends stderr somewhere other than
 * the log. `2>/dev/null` is the house form — a file would only tempt someone
 * to print it. The step still fails on a non-zero exit; an operator reads the
 * failure in the Convex dashboard, where the detail belongs.
 *
 * Run `--self-test` to check the rule itself.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = ".github/workflows";

/**
 * The text with everything inside single or double quotes blanked out, so a
 * `}` in a JSON argument is not read as the end of a command and a `2>` inside
 * a string is not read as a redirect. Walks from an unquoted start.
 */
function outsideQuotes(text) {
  const out = [];
  let quote = null;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote === '"' && char === "\\") {
      out.push("_", "_");
      at += 1;
      continue;
    }
    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      out.push("_");
    } else if (quote === char) {
      quote = null;
      out.push("_");
    } else out.push(quote === null ? char : "_");
  }
  return out.join("");
}

/**
 * Whether one line's `convex run` command sends stderr away from the log.
 * The redirect has to belong to `convex run` itself, so it must appear before
 * the command ends: a pipe into something else, or a closing `)`/`}`.
 */
export function redirectsStderr(line) {
  const at = line.indexOf("convex run");
  if (at === -1) return true;
  const rest = outsideQuotes(line.slice(at));
  const ends = [rest.indexOf("|"), rest.indexOf(")"), rest.indexOf("}")].filter((index) => index !== -1);
  const command = ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
  return /2>/.test(command);
}

/** Every `{file, line, text}` in the workflows whose `convex run` leaves stderr attached. */
export function offenders(files) {
  const found = [];
  for (const { name, text } of files) {
    text.split("\n").forEach((line, index) => {
      if (!line.includes("convex run")) return;
      if (line.trimStart().startsWith("#")) return;
      if (!redirectsStderr(line)) found.push({ file: name, line: index + 1, text: line.trim() });
    });
  }
  return found;
}

function selfTest() {
  const cases = [
    ['answer=$(npx convex run functions/a:b "$args" 2>/dev/null)', true],
    ['answer=$(npx convex run functions/a:b "$args")', false],
    ["npx convex run functions/a:b 2>/dev/null", true],
    ["npx convex run functions/a:b", false],
    ['echo "x: $(npx convex run functions/a:b 2>/dev/null | jq -c .)"', true],
    ['echo "x: $(npx convex run functions/a:b | jq -c . 2>/dev/null)"', false],
    // A `}` or `)` inside a quoted argument does not end the command.
    ['npx convex run functions/a:b "{\\"since\\":\\"$SINCE\\"}" 2>/dev/null', true],
    ['npx convex run functions/a:b "{\\"since\\":\\"$SINCE\\"}"', false],
    ['answer=$(npx convex run functions/a:b "{\\"n\\":\\"$H\\"}" 2>/dev/null)', true],
    ["npx convex run functions/a:b '{\"a\": 1}' 2>/dev/null", true],
    // Nor does a `2>` that is only part of a string.
    ['npx convex run functions/a:b "say 2>/dev/null"', false],
    ["# npx convex run functions/a:b is how it used to go", true],
    ["nothing to see here", true],
  ];
  let bad = 0;
  for (const [line, want] of cases) {
    const got = line.trimStart().startsWith("#") ? true : redirectsStderr(line);
    if (got !== want) {
      bad += 1;
      console.error(`self-test: expected ${want} for ${line}`);
    }
  }
  const sample = offenders([{ name: "sample.yml", text: 'a\n  answer=$(npx convex run f:g "$a")\n' }]);
  if (sample.length !== 1 || sample[0].line !== 2) {
    bad += 1;
    console.error("self-test: offenders() did not name the one bad line");
  }
  if (bad > 0) process.exit(1);
  console.log("OK — the convex-run stderr rule holds on its own cases.");
}

function main() {
  const files = readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({ name: join(WORKFLOWS, name), text: readFileSync(join(WORKFLOWS, name), "utf8") }));
  const found = offenders(files);
  if (found.length === 0) {
    console.log(`OK — every \`convex run\` in ${files.length} workflow files keeps its function's log lines out of the public job log.`);
    return;
  }
  console.error("This repository is public, and so is every workflow log. `npx convex run` prints the function's own");
  console.error("`console.*` lines to stderr, so these invocations publish them. Send stderr elsewhere (`2>/dev/null`):");
  for (const { file, line, text } of found) console.error(`  ${file}:${line}  ${text}`);
  process.exit(1);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
