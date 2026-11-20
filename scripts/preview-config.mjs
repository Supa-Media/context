#!/usr/bin/env node

/**
 * Renders and checks the per-pull-request preview configs.
 *
 * Three committed Wrangler configs (apps/mcp/wrangler.toml, apps/agent/wrangler.jsonc and
 * infra/router/wrangler.jsonc) each carry an `env.preview` section written with two placeholders:
 * `__PREVIEW__` becomes `pr<N>` and `__WORKERS_DEV__` becomes the account's workers.dev subdomain.
 * This script renders a copy of each beside its original, so relative paths still resolve, and then
 * checks that the rendered preview section names no production identifier.
 *
 * The subdomain is an account identifier, so it is never committed and never printed. Problems name
 * the check that failed, never the value that failed it.
 *
 *   node scripts/preview-config.mjs render --pr <N> --subdomain <SUB> [--only mcp,agent,router]
 *   node scripts/preview-config.mjs check --pr <N> [--only mcp,agent,router]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

export const PLACEHOLDER_PREVIEW = "__PREVIEW__";
export const PLACEHOLDER_WORKERS_DEV = "__WORKERS_DEV__";

// The same shape as the preview name `pr<N>` in apps/convex/functions/lib/previewDeployment.ts: a positive
// whole number with no leading zero and at most seven digits.
export const PR_PATTERN = /^[1-9][0-9]{0,6}$/;
// A workers.dev subdomain label: lowercase letters, digits and interior hyphens, at most 63 characters.
export const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The three configs, their rendered copies (gitignored) and the file type each one is. */
export const SOURCES = [
  { id: "mcp", kind: "toml", source: "apps/mcp/wrangler.toml", rendered: "apps/mcp/wrangler.preview.toml" },
  { id: "agent", kind: "jsonc", source: "apps/agent/wrangler.jsonc", rendered: "apps/agent/wrangler.preview.jsonc" },
  { id: "router", kind: "jsonc", source: "infra/router/wrangler.jsonc", rendered: "infra/router/wrangler.preview.jsonc" },
];

/** The only Workers a preview section may bind to, given its pull request number. */
function allowedServices(name) {
  return new Set([
    `context-mcp-${name}`,
    `context-agent-${name}`,
    "context-site-shots-staging",
    "context-tex-eval-staging",
    "context-transcribe-staging",
  ]);
}

/** Bindings a preview must never declare, at any depth (JSON) or as a table header or key (TOML). */
const FORBIDDEN_BINDING_KEYS = ["vectorize", "d1_databases", "r2_buckets"];

function validPr(pr) {
  const text = String(pr);
  if (!PR_PATTERN.test(text)) throw new Error("--pr must be a positive whole number (no leading zero, at most seven digits)");
  return text;
}

function previewName(pr) {
  return `pr${validPr(pr)}`;
}

/**
 * Replaces the two placeholders. Throws on a malformed pr or subdomain, and the message never includes
 * the subdomain value.
 */
export function renderConfig(text, { pr, subdomain }) {
  const name = previewName(pr);
  if (typeof subdomain !== "string" || !SUBDOMAIN_PATTERN.test(subdomain)) {
    throw new Error("--subdomain must be a workers.dev subdomain label (lowercase letters, digits and hyphens)");
  }
  return text.split(PLACEHOLDER_PREVIEW).join(name).split(PLACEHOLDER_WORKERS_DEV).join(`${subdomain}.workers.dev`);
}

/**
 * Removes // and block comments from JSONC. Only text outside string literals is touched, because the
 * configs hold URLs such as "https://...", and a slash pair inside a string is not a comment.
 */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      if (ch === "\\") {
        out += ch + (next ?? "");
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("JSONC has an unterminated block comment");
      // Keep the line breaks, so JSON.parse errors still point at the right line.
      out += text.slice(i, end + 2).replace(/[^\n]/g, "");
      i = end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Removes a comma that is directly followed by a closing brace or bracket, outside strings. */
function stripTrailingCommas(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        out += ch + (text[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/** Parses a JSONC config (comments and trailing commas allowed) into a plain object. */
export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

/**
 * The `env.preview` section of a config, as text. TOML: from the first line that starts `[env.preview`
 * (or `[[env.preview.`) to the end of the file, since the section is last. JSONC: the parsed
 * `env.preview` object, re-serialised so the checks can read it. Returns "" when the section is absent.
 */
export function previewSection(text, kind) {
  if (kind === "toml") {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => /^\[\[?env\.preview(?=[.\]])/.test(line));
    return start === -1 ? "" : lines.slice(start).join("\n");
  }
  if (kind === "jsonc") {
    const preview = parseJsonc(text)?.env?.preview;
    return preview === undefined ? "" : JSON.stringify(preview, null, 2);
  }
  throw new Error(`unknown config kind: ${kind}`);
}

/** Every key with one of the given names, at any depth of a parsed object. */
function keysNamed(value, names, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) keysNamed(item, names, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (names.includes(key)) found.push(key);
      keysNamed(child, names, found);
    }
  }
  return found;
}

/** Checks on a JSON-serialised preview section: structure, not text. */
function jsonProblems(root, name, problems) {
  for (const key of new Set(keysNamed(root, FORBIDDEN_BINDING_KEYS))) {
    problems.push(`the preview binds "${key}", which a preview must never have`);
  }
  for (const entry of root.services ?? []) {
    if (!allowedServices(name).has(entry?.service)) {
      problems.push(`the preview binds service "${entry?.service}", which is not one of its own or an allowed shared Worker`);
    }
  }
  for (const entry of root.workflows ?? []) {
    if (typeof entry?.name !== "string" || !entry.name.endsWith(`-${name}`)) {
      problems.push("a preview workflow name does not end with the preview name");
    }
  }
  const datasets = [];
  collectDatasets(root, datasets);
  for (const dataset of datasets) {
    if (typeof dataset !== "string" || !dataset.endsWith("_preview")) {
      problems.push("an Analytics Engine dataset in the preview does not end with _preview");
    }
  }
}

function collectDatasets(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectDatasets(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "dataset") out.push(child);
      collectDatasets(child, out);
    }
  }
}

/** Checks on a TOML preview section, by its lines. */
function tomlProblems(section, name, problems) {
  for (const match of section.matchAll(/^\s*\[\[?(?:env\.preview\.)?(vectorize|d1_databases|r2_buckets)(?:\.|\])/gm)) {
    problems.push(`the preview declares "${match[1]}", which a preview must never have`);
  }
  for (const match of section.matchAll(/^\s*(vectorize|d1_databases|r2_buckets)\s*=/gm)) {
    problems.push(`the preview declares "${match[1]}", which a preview must never have`);
  }
  for (const match of section.matchAll(/^\s*service\s*=\s*"([^"]*)"/gm)) {
    if (!allowedServices(name).has(match[1])) {
      problems.push(`the preview binds service "${match[1]}", which is not one of its own or an allowed shared Worker`);
    }
  }
  for (const match of section.matchAll(/^\s*dataset\s*=\s*"([^"]*)"/gm)) {
    if (!match[1].endsWith("_preview")) {
      problems.push("an Analytics Engine dataset in the preview does not end with _preview");
    }
  }
}

/**
 * Production-identifier problems in one rendered env.preview section. Returns a list of messages, empty
 * when the section is clean. `deny` is a list of production identifiers (Convex deployment names, bucket
 * names and the like); an entry that appears anywhere in the section is a problem, and the entry itself
 * is never printed.
 */
export function configProblems(section, { pr, deny = [] } = {}) {
  const name = previewName(pr);
  if (typeof section !== "string" || section.trim() === "") {
    return ["the env.preview section is missing or empty"];
  }
  const problems = [];
  if (section.includes(PLACEHOLDER_PREVIEW) || section.includes(PLACEHOLDER_WORKERS_DEV)) {
    problems.push("a placeholder (__PREVIEW__ or __WORKERS_DEV__) was left unrendered");
  }
  if (/(?<![A-Za-z0-9-])(?:context|tex)\.lc(?![A-Za-z0-9])/i.test(section)) {
    problems.push("the preview names a production host (context.lc or tex.lc, any subdomain)");
  }
  if (section.includes("PHOTON")) {
    problems.push("the preview names a PHOTON binding, the iMessage bridge");
  }
  if (section.includes("tex-examples")) {
    problems.push("the preview names the tex-examples index");
  }
  for (const entry of deny) {
    if (typeof entry === "string" && entry.trim() !== "" && section.includes(entry.trim())) {
      problems.push("the preview names a production identifier from PREVIEW_DENY_IDENTIFIERS");
    }
  }
  let root = null;
  try {
    root = JSON.parse(section);
  } catch {
    root = null;
  }
  if (root !== null && typeof root === "object") {
    jsonProblems(root, name, problems);
  } else {
    tomlProblems(section, name, problems);
  }
  return [...new Set(problems)];
}

/** Production identifiers, from PREVIEW_DENY_IDENTIFIERS (comma, space or newline separated). */
export function denyList(env = process.env) {
  return (env.PREVIEW_DENY_IDENTIFIERS ?? "").split(/[\s,]+/).filter((entry) => entry !== "");
}

/** Problems for one rendered file's text, including any placeholder left anywhere in the file. */
export function renderedProblems(text, kind, { pr, deny = [] }) {
  const problems = configProblems(previewSection(text, kind), { pr, deny });
  if (text.includes(PLACEHOLDER_PREVIEW) || text.includes(PLACEHOLDER_WORKERS_DEV)) {
    problems.push("a placeholder (__PREVIEW__ or __WORKERS_DEV__) was left unrendered in the file");
  }
  return [...new Set(problems)];
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`expected --name value pairs, got "${key ?? ""}"`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function selectSources(only) {
  if (only === undefined) return SOURCES;
  const wanted = only.split(",").map((id) => id.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !SOURCES.some((source) => source.id === id));
  if (unknown.length > 0) throw new Error(`--only names an unknown config (use mcp, agent, router)`);
  return SOURCES.filter((source) => wanted.includes(source.id));
}

function usage() {
  return "usage: preview-config.mjs render --pr <N> --subdomain <SUB> [--only mcp,agent,router]\n"
    + "       preview-config.mjs check --pr <N> [--only mcp,agent,router]\n";
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}`);
    return 2;
  }
  const { command, options } = parsed;
  if (command !== "render" && command !== "check") {
    process.stderr.write(usage());
    return 2;
  }
  let sources;
  try {
    validPr(options.pr);
    sources = selectSources(options.only);
    if (command === "render" && !SUBDOMAIN_PATTERN.test(options.subdomain ?? "")) {
      throw new Error("--subdomain must be a workers.dev subdomain label (lowercase letters, digits and hyphens)");
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}`);
    return 2;
  }
  const deny = denyList();
  const writtenPaths = [];
  let failed = false;
  for (const source of sources) {
    const problems = [];
    if (command === "render") {
      const sourcePath = `${REPO}${source.source}`;
      if (!existsSync(sourcePath)) {
        problems.push(`${source.source} is missing`);
      } else {
        const rendered = renderConfig(readFileSync(sourcePath, "utf8"), { pr: options.pr, subdomain: options.subdomain });
        writeFileSync(`${REPO}${source.rendered}`, rendered);
        writtenPaths.push(source.rendered);
        problems.push(...renderedProblems(rendered, source.kind, { pr: options.pr, deny }));
      }
    } else {
      const renderedPath = `${REPO}${source.rendered}`;
      if (!existsSync(renderedPath)) {
        problems.push(`${source.rendered} is missing; run render first`);
      } else {
        problems.push(...renderedProblems(readFileSync(renderedPath, "utf8"), source.kind, { pr: options.pr, deny }));
      }
    }
    for (const problem of problems) {
      failed = true;
      process.stderr.write(`${source.id}: ${problem}\n`);
    }
  }
  for (const path of writtenPaths) process.stdout.write(`rendered ${path}\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
