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
 * A log with no lines at all fails too. The suite has to have sent at least
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

const lines = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

const counts = new Map();
for (const { document, directive, blocked, disposition } of lines) {
  const key = `${document}\t${directive}\t${blocked}\t${disposition}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log("count\tdocument\tdirective\tblocked\tdisposition");
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${count}\t${key}`);

const refused = lines.filter(
  ({ directive, disposition }) =>
    disposition === "enforce" && guarded.some((name) => directive === name || directive.startsWith(`${name}-`)),
);
if (lines.length === 0) {
  console.error("no violation was reported at all, so this run cannot say reporting works");
  process.exit(1);
}
if (refused.length > 0) {
  console.error(`${refused.length} enforced violation(s) of ${guarded.join(", ")}: the candidate would break what these specs cover`);
  process.exit(1);
}
console.log(`no enforced violation of ${guarded.join(", ")} in ${lines.length} report(s)`);
