#!/usr/bin/env node
/**
 * What a CSP candidate run (`csp-candidate.ts`) recorded, and whether it is
 * acceptable for the directives being moved to enforcement.
 *
 * Prints every recorded violation as counts by document class, directive,
 * blocked source and disposition: the log holds nothing else, so neither
 * does this. Exits non-zero if any *enforced* violation names one of the
 * directives given (`script-src` by default, which also matches
 * `script-src-elem` and `script-src-attr`): those are the ones the candidate
 * claims the app no longer needs. Violations of other directives are printed
 * and left to the decision they belong to.
 *
 * A row it cannot interpret fails the run too: an "unknown" directive or
 * disposition, a missing field, or a line that is not JSON. And a log with no
 * readable lines at all fails. The suite has to have sent at least
 * one report for the run to say anything about reporting, and the shell's
 * known style violations (`docs/decisions/testing/csp-candidate.md`)
 * guarantee one until they are fixed; when they are, this check is the one to
 * change, not the one to delete.
 *
 * Usage: `node csp-candidate-check.mjs <reports.jsonl> [directive…]`
 */
import { readFileSync } from "node:fs";

const [, , file, ...named] = process.argv;
if (file === undefined) {
  console.error("usage: node csp-candidate-check.mjs <reports.jsonl> [directive…]");
  process.exit(2);
}
const guarded = named.length > 0 ? named : ["script-src"];

/** A parsed line, or `null` for one that is not JSON. */
function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const lines = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map(parse);

/**
 * A row this check can read: four strings, a real directive name, and a
 * disposition that says whether the browser blocked it. An "unknown"
 * directive or disposition is a report nobody can attribute, so it can
 * neither be the evidence that reporting works nor be skipped past by the
 * guard below; it fails the run, and is never dropped.
 */
function interpretable(row) {
  if (row === null || typeof row !== "object") return false;
  const { document, directive, blocked, disposition } = row;
  if (![document, directive, blocked, disposition].every((field) => typeof field === "string")) return false;
  return /^[a-z-]{1,40}$/.test(directive) && directive !== "unknown" && (disposition === "enforce" || disposition === "report");
}

const counts = new Map();
for (const row of lines) {
  const key = interpretable(row)
    ? `${row.document}\t${row.directive}\t${row.blocked}\t${row.disposition}`
    : "(uninterpretable)\t-\t-\t-";
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log("count\tdocument\tdirective\tblocked\tdisposition");
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${count}\t${key}`);

const readable = lines.filter(interpretable);
const unreadable = lines.length - readable.length;
const refused = readable.filter(
  ({ directive, disposition }) =>
    disposition === "enforce" && guarded.some((name) => directive === name || directive.startsWith(`${name}-`)),
);
if (unreadable > 0) {
  console.error(`${unreadable} report(s) name no known directive or disposition, so this run cannot say what was blocked`);
  process.exit(1);
}
if (readable.length === 0) {
  console.error("no violation was reported at all, so this run cannot say reporting works");
  process.exit(1);
}
if (refused.length > 0) {
  console.error(`${refused.length} enforced violation(s) of ${guarded.join(", ")}: the candidate would break what these specs cover`);
  process.exit(1);
}
console.log(`no enforced violation of ${guarded.join(", ")} in ${readable.length} report(s)`);
