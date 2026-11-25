#!/usr/bin/env node
/**
 * TEX'S CODE HANDS OVER FACTS. IT NEVER WRITES WHAT TEX SAYS (Dev2, 2026-11-25, a hard rule for every writer;
 * docs/decisions/texting-assistant/no-scripted-wording.md).
 *
 * An audit that day found about 110 texts sent with no model and about 1,330 sentences of prompt written in code,
 * five times what the Lab's prompt modules hold, grown from about 200 in mid-October: each bad interaction had been
 * fixed with a sentence where it showed up. Nothing counted them, so nothing stopped them.
 *
 * This counts them. A "sentence" is a string or template literal in Tex's code with five or more words. Tests,
 * logs, thrown errors, tool `description`s and the capability list are not counted (`skipped`). Each file's count
 * lives in `packages/tex/wording.json`, and this fails when:
 *
 *   - a file holds more sentences than the list says (new wording: hand the model a fact as data, teach behaviour
 *     with a Training conversation, put a policy in a Lab prompt module, or build the tool that was missing);
 *   - a file holds fewer than the list says (wording was removed: lower its number with `--write`, so the list only
 *     shrinks and always says what is left);
 *   - with `--base <sha>`, the list's total rose, or one file's number rose, against the base branch. A file new to
 *     the list may carry sentences only when the total did not rise (a move or a split). The one way past is a line
 *     of its own in the pull request description, quoting Dev2's own words:
 *
 *       Tex wording raised on the owner's call: <Dev2's words, and where they said them>
 *
 * Plain Node over files in this repository, so it needs no install.
 *
 *   node scripts/tex-wording-check.mjs [--base <sha>]   # CI: TEX_PR_BODY is the description
 *   node scripts/tex-wording-check.mjs --write          # lower the list after removing wording
 *   node scripts/tex-wording-check.mjs --self-test
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const LIST = "packages/tex/wording.json";
export const FOLDERS = ["packages/tex/worker", "packages/tex/gateway", "packages/tex/src", "apps/agent/src"];
const SOURCE = /\.(?:m?js|cjs|ts)$/;
/** Not Tex's words: tests, generated files, type declarations, and the capability list (decided 2026-11-08). */
const SKIP_FILE = /(?:\.test\.|\.testing\.|\/test\/|\/bench\/|generated|\.d\.c?ts$|gateway\/agent\/capabilities\.js$)/;
/** A call whose strings are logs or errors, never shown to Tex or a person as its words. */
const LOG_CALL = /^(?:console\.\w+|log\w*|\w*\.log\w*|warn|debug|trace|(?:new )?\w*Error)$/;
/** An object key whose value describes a tool or a setting to a developer or a tool caller. */
const DESCRIBES = /^(?:description|summary)$/;
export const MIN_WORDS = 5;
const RAISED = /^\s*Tex wording raised on the owner's call:\s*(.+?)\s*$/im;
const MIN_REASON = 20;
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);

/**
 * The string and template literals in one file's source, with what came just before each:
 * [{ text, key, call }], a template's `${…}` parts as "X". A small lexer, not a parser: strings, templates,
 * comments and regular expressions are told apart; `"a " + x + " b"` chains are joined into one.
 */
export function literalsOf(source) {
  const out = [];
  const calls = []; // callee name at each open paren
  const braces = []; // for templates: depth at which a `${` opened
  let depth = 0;
  let prev = null; // { type, value }
  let i = 0;
  const n = source.length;
  const push = (text) => {
    const two = out.length > 0 && prev?.type === "join" ? out[out.length - 1] : null;
    const key = prev?.type === "colon" ? prev.key : null;
    const call = calls.length > 0 ? calls[calls.length - 1] : null;
    if (two) two.text += text;
    else out.push({ text, key, call });
    prev = { type: "string" };
  };
  const readQuoted = (quote) => {
    let text = "";
    i++;
    while (i < n && source[i] !== quote) {
      if (source[i] === "\\") { text += source[i + 1] ?? ""; i += 2; continue; }
      if (source[i] === "\n") break;
      text += source[i++];
    }
    i++;
    return text;
  };
  // Reads template text from i (just after ` or a closing } of `${`), until ` or `${`.
  const readTemplate = () => {
    let text = "";
    while (i < n) {
      const c = source[i];
      if (c === "\\") { text += source[i + 1] ?? ""; i += 2; continue; }
      if (c === "`") { i++; return { text, open: false }; }
      if (c === "$" && source[i + 1] === "{") { i += 2; return { text: text + " X ", open: true }; }
      text += c;
      i++;
    }
    return { text, open: false };
  };
  let template = null; // the literal being built while inside `${`
  const templates = [];
  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") { while (i < n && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? n : end + 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") { push(readQuoted(c)); continue; }
    if (c === "`") {
      i++;
      const part = readTemplate();
      const literal = { text: part.text, key: prev?.type === "colon" ? prev.key : null, call: calls.at(-1) ?? null, join: prev?.type === "join" };
      if (part.open) { templates.push(literal); braces.push(depth); depth++; prev = { type: "punct", value: "{" }; continue; }
      finishTemplate(literal);
      continue;
    }
    if (c === "/") {
      const regexStart = prev === null || (prev.type === "punct" && !")]".includes(prev.value)) || prev.type === "colon" || prev.type === "join" || (prev.type === "word" && KEYWORDS_BEFORE_REGEX.has(prev.value));
      if (regexStart) {
        i++;
        let inClass = false;
        while (i < n && source[i] !== "\n") {
          if (source[i] === "\\") { i += 2; continue; }
          if (source[i] === "[") inClass = true;
          else if (source[i] === "]") inClass = false;
          else if (source[i] === "/" && !inClass) break;
          i++;
        }
        i++;
        while (i < n && /[a-z]/i.test(source[i])) i++;
        prev = { type: "regex" };
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$.]/.test(source[j])) j++;
      const word = source.slice(i, j);
      i = j;
      if (prev?.type === "word" && prev.value === "new") prev = { type: "word", value: `new ${word}` };
      else prev = { type: "word", value: word, chained: prev?.type === "join" };
      continue;
    }
    if (/[0-9]/.test(c)) { while (i < n && /[\w.]/.test(source[i])) i++; prev = { type: "number" }; continue; }
    // punctuation
    i++;
    if (c === "(") { calls.push(prev?.type === "word" ? prev.value : null); prev = { type: "punct", value: c }; continue; }
    if (c === ")") { calls.pop(); prev = { type: "punct", value: c }; continue; }
    if (c === "{") { depth++; prev = { type: "punct", value: c }; continue; }
    if (c === "}") {
      depth--;
      if (braces.length > 0 && braces[braces.length - 1] === depth) {
        braces.pop();
        const literal = templates.pop();
        const part = readTemplate();
        literal.text += part.text;
        if (part.open) { templates.push(literal); braces.push(depth); depth++; prev = { type: "punct", value: "{" }; continue; }
        finishTemplate(literal);
        continue;
      }
      prev = { type: "punct", value: c };
      continue;
    }
    if (c === ":" && (prev?.type === "word" || prev?.type === "string")) {
      prev = { type: "colon", key: prev.type === "word" ? prev.value : out.at(-1)?.text ?? null };
      if (prev.key !== null && out.length > 0 && out.at(-1).text === prev.key && prev.key.split(/\s+/).length < MIN_WORDS) out.pop();
      continue;
    }
    if (c === "+" && source[i] !== "+" && source[i] !== "=" && (prev?.type === "string" || (prev?.type === "word" && prev.chained))) {
      prev = { type: "join" };
      continue;
    }
    prev = { type: "punct", value: c };
  }
  return out;

  function finishTemplate(literal) {
    if (literal.join && out.length > 0) out[out.length - 1].text += literal.text;
    else out.push({ text: literal.text, key: literal.key, call: literal.call });
    prev = { type: "string" };
  }
}

/** How many words a literal has: runs of two or more letters, a template's parts counted as one word, HTML tags and their styles left out. */
export function wordsIn(text) {
  return text.replace(/<[^>]*>/g, " ").split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word) || word === "X").length;
}

/** Whether one literal counts as a sentence of Tex's wording. */
export function counts({ text, key, call }) {
  if (wordsIn(text) < MIN_WORDS) return false;
  if (call && LOG_CALL.test(call)) return false;
  if (key && DESCRIBES.test(key)) return false;
  if (/^(?:https?:|\.{0,2}\/)\S*$/.test(text.trim())) return false;
  return true;
}

/** Sentences per file in `files` ({ path, text }): only files that hold any. */
export function countFiles(files) {
  const found = {};
  for (const { path, text } of files) {
    if (SKIP_FILE.test(path)) continue;
    const number = literalsOf(text).filter(counts).length;
    if (number > 0) found[path] = number;
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(join(ROOT, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(path); }
      else if (SOURCE.test(entry.name)) files.push({ path, text: readFileSync(join(ROOT, path), "utf8") });
    }
  };
  FOLDERS.forEach(walk);
  return files;
}

const total = (list) => Object.values(list).reduce((sum, value) => sum + value, 0);

/** What is wrong between the code's counts and the list; [] when they agree. */
export function againstList(found, list) {
  const problems = [];
  for (const [path, number] of Object.entries(found)) {
    const allowed = list[path] ?? 0;
    if (number > allowed) problems.push(`${path}: ${number} sentences written in code, the list allows ${allowed}. Hand Tex the fact as data, teach it with Training, or build the missing tool.`);
  }
  for (const [path, allowed] of Object.entries(list)) {
    if ((found[path] ?? 0) < allowed) problems.push(`${path}: the list says ${allowed}, the code now holds ${found[path] ?? 0}. Run node scripts/tex-wording-check.mjs --write to lower it.`);
  }
  return problems;
}

/** What rose between the base branch's list and this one; [] when nothing did. */
export function raises(base, head) {
  const found = [];
  if (total(head) > total(base)) found.push(`the total rose from ${total(base)} to ${total(head)}`);
  for (const [path, number] of Object.entries(head)) {
    if (path in base && number > base[path]) found.push(`${path} rose from ${base[path]} to ${number}`);
  }
  return found;
}

/** Null when the rise is allowed, else what is missing. */
export function verdict(base, head, body = "") {
  const found = raises(base, head);
  if (found.length === 0) return null;
  const reason = RAISED.exec(body ?? "")?.[1] ?? "";
  if (reason.length >= MIN_REASON) return null;
  return (
    `This pull request adds wording written in code to Tex (${LIST}): ${found.join("; ")}.\n` +
    "Code hands Tex facts; it never writes what Tex says (docs/decisions/texting-assistant/no-scripted-wording.md).\n" +
    "Only Dev2 can allow more, quoted on its own line: Tex wording raised on the owner's call: <Dev2's words, and where>."
  );
}

function readList(text) {
  const parsed = JSON.parse(text);
  return parsed.files ?? {};
}

function writeList(found) {
  const body = {
    why: "Sentences of Tex's wording still written in code, per file. Only shrinks (scripts/tex-wording-check.mjs; docs/decisions/texting-assistant/no-scripted-wording.md).",
    total: total(found),
    files: found,
  };
  writeFileSync(join(ROOT, LIST), `${JSON.stringify(body, null, 2)}\n`);
}

function selfTest() {
  const assert = (ok, what) => { if (!ok) { console.error(`self-test failed: ${what}`); process.exit(1); } };
  const sample = [
    'const a = "Done. I invited one person here today";',
    "const b = `I'm already running ${count} things for you now`;",
    'console.log("this is a log line with many words");',
    'throw new Error("this is an error with many words in it");',
    'const tool = { description: "Keep the name of someone in this chat" };',
    'const re = /it\'s "not a string" at all here/;',
    "// a comment with \"quoted words that are not code\"",
    'const c = "short one";',
    'const html = `<div style="width: 64px; flex-shrink: 0; font-size: 13px">${x}</div>`;',
    'const d = "You can start a real poll " + who + " in this chat";',
    "const e = `outer ${`inner words are here and count`} end`;",
  ].join("\n");
  const literals = literalsOf(sample).filter(counts).map((l) => l.text);
  assert(literals.some((t) => t.startsWith("Done. I invited")), "a plain sentence counts");
  assert(literals.some((t) => t.startsWith("I'm already running")), "a template counts");
  assert(!literals.some((t) => t.includes("log line")), "a log is skipped");
  assert(!literals.some((t) => t.includes("an error")), "an error is skipped");
  assert(!literals.some((t) => t.startsWith("Keep the name")), "a tool description is skipped");
  assert(!literals.some((t) => t.includes("not a string")), "a regular expression is not a string");
  assert(!literals.some((t) => t.includes("quoted words")), "a comment is not a string");
  assert(literals.filter((t) => t.includes("real poll")).length === 1, "a + chain is one sentence");
  assert(literals.some((t) => t.includes("inner words")), "a nested template counts");
  assert(!literals.some((t) => t.includes("flex-shrink")), "markup is not wording");
  const found = countFiles([{ path: "packages/tex/worker/x.ts", text: sample }, { path: "packages/tex/worker/x.test.ts", text: sample }]);
  assert(Object.keys(found).length === 1, "tests are skipped");
  assert(againstList({ a: 3 }, { a: 2 }).length === 1, "a rise fails");
  assert(againstList({ a: 1 }, { a: 2 }).length === 1, "a stale list fails");
  assert(againstList({ a: 2 }, { a: 2 }).length === 0, "an equal count passes");
  assert(verdict({ a: 2 }, { a: 3 }) !== null, "a raise against base fails");
  assert(verdict({ a: 2 }, { b: 2 }) === null, "a move into a new file passes");
  assert(verdict({ a: 2 }, { a: 2, b: 1 }) !== null, "a new file that raises the total fails");
  assert(verdict({ a: 2 }, { a: 3 }, "Tex wording raised on the owner's call: Dev2 in the thread, 2026-11-26: keep the outage line") === null, "the owner's line passes");
  assert(verdict({ a: 2 }, { a: 3 }, "Tex wording raised on the owner's call: ok") !== null, "a short reason does not");
  console.log("tex-wording-check self-test ok");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  const found = countFiles(sourceFiles());
  if (args.includes("--write")) {
    writeList(found);
    console.log(`${LIST}: ${total(found)} sentences in ${Object.keys(found).length} files`);
    return;
  }
  const list = readList(readFileSync(join(ROOT, LIST), "utf8"));
  const problems = againstList(found, list);
  const baseAt = args.indexOf("--base");
  const base = baseAt >= 0 ? args[baseAt + 1] : process.env.BASE_SHA;
  if (base) {
    let baseText = null;
    try { baseText = execFileSync("git", ["show", `${base}:${LIST}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    if (baseText !== null) {
      const said = verdict(readList(baseText), list, process.env.TEX_PR_BODY ?? "");
      if (said) problems.push(said);
    }
  }
  if (problems.length > 0) {
    console.error(`Tex's wording is written in code where it should not be:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`tex-wording-check: ${total(found)} sentences written in code, none new`);
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === "") main();
