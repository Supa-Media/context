import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * `csp-candidate-check.mjs` decides whether a CSP candidate run is evidence,
 * so each way a log could look green without saying anything is a case here.
 */
const CHECK = join(import.meta.dirname, "csp-candidate-check.mjs");
const DIR = mkdtempSync(join(tmpdir(), "csp-check-"));

function run(name, rows, ...directives) {
  const file = join(DIR, `${name}.jsonl`);
  writeFileSync(file, rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n"));
  return spawnSync(process.execPath, [CHECK, file, ...directives], { encoding: "utf8" });
}

const STYLE_REPORT = { document: "shell", directive: "style-src-elem", blocked: "inline", disposition: "report" };
const SCRIPT_REPORT = { document: "shell", directive: "script-src-elem", blocked: "inline", disposition: "report" };
const SCRIPT_ENFORCED = { ...SCRIPT_REPORT, disposition: "enforce" };

test("passes a readable log with no enforced script violation", () => {
  const result = run("clean", [STYLE_REPORT, SCRIPT_REPORT, { ...STYLE_REPORT, disposition: "enforce" }]);
  assert.equal(result.status, 0, result.stderr);
});

test("fails an enforced script-src, -elem or -attr violation", () => {
  for (const directive of ["script-src", "script-src-elem", "script-src-attr"]) {
    assert.equal(run(directive, [STYLE_REPORT, { ...SCRIPT_ENFORCED, directive }]).status, 1, directive);
  }
});

test("fails an empty log", () => {
  assert.equal(run("empty", []).status, 1);
});

test("fails a log whose only rows cannot be read, rather than counting them as reports", () => {
  assert.equal(run("only-unknown", [{ ...STYLE_REPORT, directive: "unknown" }]).status, 1);
  assert.equal(run("only-bad-disposition", [{ ...STYLE_REPORT, disposition: "unknown" }]).status, 1);
});

test("fails an unreadable row beside readable ones, and does not drop it", () => {
  const cases = {
    "unknown-directive": { ...SCRIPT_ENFORCED, directive: "unknown" },
    "unknown-disposition": { ...SCRIPT_ENFORCED, disposition: "unknown" },
    "missing-disposition": { document: "shell", directive: "script-src-elem", blocked: "inline" },
    "other-disposition": { ...SCRIPT_REPORT, disposition: "Enforce" },
    "non-string-directive": { ...SCRIPT_REPORT, directive: 7 },
    "path-shaped-directive": { ...SCRIPT_REPORT, directive: "script-src /a" },
    "not-json": "{not json",
    "not-an-object": "42",
  };
  for (const [name, row] of Object.entries(cases)) {
    const result = run(name, [STYLE_REPORT, row]);
    assert.equal(result.status, 1, name);
    assert.match(result.stdout, /\(uninterpretable\)/, name);
  }
});
