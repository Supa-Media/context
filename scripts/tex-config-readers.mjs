#!/usr/bin/env node
/**
 * ONE LOADER, ONE SCHEMA, CHECKED (Dev2, 2026-11-17: "make sure that when we make updates or changes to the schema
 * everything is updated"; chose "A + B + schema, no split").
 *
 * Fails when:
 *   - a file names `texConfig.json` in code (a string, an import, a require) other than the loaders: runtime code reads
 *     `packages/tex/src/texConfig.cjs`, Node scripts `scripts/lib/texConfigFile.mjs`, so every reader gets a config
 *     checked against `texConfigSchema.cjs`, and a schema change cannot miss a reader that parses the file its own way;
 *   - the committed config does not match its schema, or is behind its version (`tex-config-migrate.mjs`);
 *   - `SCHEMA_VERSION` was bumped without its migration;
 *   - the drawing's wire legend (`tex-architecture.mjs`) or `tex_dev`'s guide (`apps/mcp/src/texDev/guide.js`) leaves out
 *     a wire mode the schema has.
 *
 *   node scripts/tex-config-readers.mjs [--self-test]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readTexConfig } from "./lib/texConfigFile.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA = createRequire(import.meta.url)("../packages/tex/src/texConfigSchema.cjs");

/** The files that may name the config file in code, and why. */
export const LOADERS = {
  "packages/tex/src/texConfig.cjs": "the runtime loader",
  "scripts/lib/texConfigFile.mjs": "the Node scripts' loader",
  "scripts/ci-change-scope.mjs": "a path in CI's change scope, not a read",
  "scripts/tex-config-readers.mjs": "this check",
  "packages/tex/src/texConfig.d.cts": "the runtime loader's types",
  "apps/mobile/features/tex/lab/engine/graphAt.ts": "the Lab reads the config at old commits from GitHub and migrates it",
};
const CODE = /\.(c|m)?(j|t)sx?$/;
/** `texConfig.json` inside a quoted string: an import, a require, a path. Comments name it in backticks, which pass. */
const NAMED = /["'](?:[^"'\n]*\/)?texConfig\.json["']/;

/** The files (repo-relative) that name the config in code but are not loaders. */
export function strayReaders(files, read) {
  return files.filter((f) => CODE.test(f) && !(f in LOADERS) && !f.includes("node_modules/") && !/\.generated\./.test(f) && NAMED.test(read(f)));
}

export function problems(root = ROOT) {
  const out = [];
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of strayReaders(files, (p) => readFileSync(join(root, p), "utf8"))) out.push(`${f} reads texConfig.json itself: read it through packages/tex/src/texConfig.cjs (runtime) or scripts/lib/texConfigFile.mjs (Node scripts)`);
  try {
    readTexConfig(root);
  } catch (error) {
    out.push(error.message);
  }
  if (SCHEMA.MIGRATIONS.length !== SCHEMA.SCHEMA_VERSION) out.push(`texConfigSchema.cjs is at version ${SCHEMA.SCHEMA_VERSION} with ${SCHEMA.MIGRATIONS.length} migrations: a version bump needs its migration`);
  const legend = readFileSync(join(root, "scripts/tex-architecture.mjs"), "utf8");
  for (const mode of SCHEMA.MODES) if (!legend.includes(`"${mode}"`)) out.push(`scripts/tex-architecture.mjs draws no wire mode "${mode}", which the schema has`);
  const guide = readFileSync(join(root, "apps/mcp/src/texDev/guide.js"), "utf8");
  for (const mode of SCHEMA.MODES) if (!new RegExp(`^\\s+${mode}: "`, "m").test(guide)) out.push(`apps/mcp/src/texDev/guide.js says nothing of the wire mode "${mode}" (MODE_MEANING), which the schema has`);
  return out;
}

function selfTest() {
  const expect = (cond, what) => {
    if (!cond) throw new Error(`tex-config-readers self-test: ${what}`);
  };
  const text = {
    "a.ts": 'import C from "@context/tex/src/texConfig.json";',
    "b.mjs": 'const c = JSON.parse(readFileSync("packages/tex/src/texConfig.json"));',
    "c.cjs": "const c = require('./texConfig.json');",
    "d.ts": "/** Reads `texConfig.json` through the loader. */",
    "e.md": '"texConfig.json"',
    "packages/tex/src/texConfig.cjs": 'require("./texConfig.json")',
  };
  const stray = strayReaders(Object.keys(text), (f) => text[f]);
  expect(stray.join() === "a.ts,b.mjs,c.cjs", `the wrong files were caught: ${stray.join()}`);
  const p = problems();
  expect(p.length === 0, `the repository has problems: ${p.join("; ")}`);
  // A step field the schema does not know is caught, and so is a mode it does not know.
  const config = readTexConfig();
  const bad = JSON.parse(JSON.stringify(config));
  bad.nodes[0].colour = "red";
  bad.edges[0].mode = "sideways";
  const said = SCHEMA.configProblems(bad).join("; ");
  expect(/does not know: colour/.test(said) && /sideways/.test(said), "an unknown field or mode passed the schema");
  // A provisional wire must keep firstLook and sms. A hand edit that drops one is the same refusal Promote gives.
  for (const fact of ["firstLook", "sms"]) {
    const held = JSON.parse(JSON.stringify(config));
    const wire = held.edges.find((e) => e.mode === "provisional");
    wire.unless = wire.unless.filter((f) => f !== fact);
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(String(line));
    let heldSaid = "";
    try {
      heldSaid = SCHEMA.configProblems(held).join("; ");
    } finally {
      console.log = log;
    }
    expect(new RegExp(`provisional wire ${wire.from} → ${wire.to} is missing the hold ${fact}`).test(heldSaid), `a provisional wire that drops ${fact} passed the schema`);
    expect(lines.some((line) => line.includes("provisional_hold_refused") && line.includes(`"missing":"${fact}"`)), `dropping ${fact} was not logged`);
  }
  // A config one version behind is named, and migrating brings it back.
  const old = { ...JSON.parse(JSON.stringify(config)), texConfig: 0 };
  old.edges.find((e) => e.mode === "background").mode = "behind";
  expect(SCHEMA.configProblems(old).some((x) => /schema version 0/.test(x)), "an old config passed");
  const up = SCHEMA.migrateGraph(old);
  expect(up.texConfig === SCHEMA.SCHEMA_VERSION && SCHEMA.configProblems(up).length === 0, `migrating an old config did not bring it to the schema: ${SCHEMA.configProblems(up).join("; ")}`);
  // A Lab draft names no version and runs through every migration; doing so twice changes nothing.
  const draft = { nodes: config.nodes, edges: [{ from: "send", to: "learn", mode: "behind", when: ["*"] }] };
  const once = SCHEMA.migrateGraph(draft);
  expect(once.edges[0].mode === "background" && JSON.stringify(SCHEMA.migrateGraph(once)) === JSON.stringify(once), "a draft's migration is not idempotent");
  console.log("tex-config-readers self-test: ok");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const p = problems();
    if (p.length > 0) {
      for (const line of p) console.error(`tex-config-readers: ${line}`);
      process.exit(1);
    }
    console.log("tex-config-readers: every reader goes through the loader, and the config matches schema version " + SCHEMA.SCHEMA_VERSION);
  }
}
